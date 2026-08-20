/**
 * Flow-diagram drift guard (§5.12) for the engine-driven (TypeScript) playbooks.
 *
 * Compares the KB playbook's EXPORTED state/edge descriptor (`KB_FLOW` — forward
 * edges derived from the machine's own NEXT_STATE table) against the
 * machine-readable `N`/`E` data embedded in `.pi/skills/knowledge-base/resources/flow.html`.
 * It fails on a missing or extra STATE, EDGE, GATE, RETRY, or TERMINAL ROUTE in
 * either direction, and asserts the authority facts the diagram must carry
 * (host-only gate decisions, host-only approval, the documented cancel seam,
 * bounded repairs, honest exhaustion).
 *
 * The TypeScript descriptors are the sole machine authority. A stale diagram is
 * a hard failure, and the diagram updates in the same change as the machine.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  KB_AGENT_PHASES,
  KB_FLOW,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
} from "../src/playbooks/knowledge-base.js";
import { RESEARCH_FLOW } from "../src/playbooks/research.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const FLOW_HTML = path.join(REPO_ROOT, ".pi", "skills", "knowledge-base", "resources", "flow.html");
const RESEARCH_FLOW_HTML = path.join(
  REPO_ROOT,
  ".pi",
  "skills",
  "research",
  "resources",
  "flow.html"
);

interface DiagramNode {
  title?: string;
  desc?: string;
  who?: string;
  badge?: string;
  decisions?: string[];
  host_only?: boolean;
  [key: string]: unknown;
}

interface DiagramEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
  bounded?: boolean;
  [key: string]: unknown;
}

/**
 * Extract the value of a `const NAME = <literal>` block and JSON-parse it. The
 * flow standard keeps N/E as strict JSON (double-quoted) precisely so the drift
 * guard can read them without executing anything.
 */
function extractConst(source: string, name: string): string {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`flow.html is missing 'const ${name} = ...'`);
  let i = start + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let opened = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
      opened = true;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (opened && depth === 0) break;
    }
  }
  if (!opened || depth !== 0) {
    throw new Error(
      `could not find the balanced 'const ${name}' value; it must be a single JSON literal`
    );
  }
  const raw = source.slice(start + marker.length, i + 1);
  try {
    JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `'const ${name}' in flow.html is not strict JSON (the drift guard reads it without executing code): ${String(error)}`
    );
  }
  return raw;
}

const html = readFileSync(FLOW_HTML, "utf8");
const N = JSON.parse(extractConst(html, "N")) as Record<string, DiagramNode>;
const E = JSON.parse(extractConst(html, "E")) as DiagramEdge[];

const nodeIds = Object.keys(N);
const edgeKey = (e: { from: string; to: string }): string => `${e.from}→${e.to}`;

const descriptorEdgeKeys = new Set(KB_FLOW.edges.map(edgeKey));
const diagramEdgeKeys = new Set(E.map(edgeKey));

describe("flow-diagrams (KB, §5.12)", () => {
  it("embeds a machine-readable data model (N: every state once, E: one edge per object)", () => {
    expect(nodeIds.length).toBe(new Set(nodeIds).size); // no duplicate states
    expect(E.length).toBeGreaterThan(0);
    for (const id of nodeIds) {
      expect(N[id].title, `node '${id}' needs a title`).toBeTruthy();
      expect(N[id].desc, `node '${id}' needs a description`).toBeTruthy();
    }
    for (const edge of E) {
      expect(nodeIds, `edge ${edgeKey(edge)}: '${edge.from}' has no node`).toContain(edge.from);
      expect(nodeIds, `edge ${edgeKey(edge)}: '${edge.to}' has no node`).toContain(edge.to);
      expect(
        ["fwd", "gate", "loop", "exit", "abort"],
        `edge ${edgeKey(edge)}: unknown kind '${edge.kind}'`
      ).toContain(edge.kind);
    }
  });

  it("draws exactly the descriptor's states — no missing, no extra", () => {
    const descriptorIds = new Set(KB_FLOW.states.map((s) => s.id));
    const diagramStates = new Set(nodeIds.filter((id) => id !== "start"));
    const missing = [...descriptorIds].filter((id) => !diagramStates.has(id));
    const extra = [...diagramStates].filter((id) => !descriptorIds.has(id));
    expect(missing, `states missing from the diagram: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `extra states in the diagram: ${extra.join(", ")}`).toEqual([]);
  });

  it("draws exactly the descriptor's edges — no missing, no extra", () => {
    const missing = [...descriptorEdgeKeys].filter((k) => !diagramEdgeKeys.has(k));
    const extra = [...diagramEdgeKeys].filter((k) => !descriptorEdgeKeys.has(k));
    expect(missing, `edges missing from the diagram: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `extra edges in the diagram: ${extra.join(", ")}`).toEqual([]);
  });

  it("classifies every edge with the descriptor's kind", () => {
    const kindMap = new Map(KB_FLOW.edges.map((e) => [edgeKey(e), e.kind]));
    const diagramKinds: Record<string, string> = { forward: "fwd", repair: "loop", gate: "gate" };
    for (const edge of E) {
      const expected = kindMap.get(edgeKey(edge));
      expect(
        expected,
        `described edge ${edgeKey(edge)} has no kind in the descriptor`
      ).toBeDefined();
      const allowed =
        expected === "terminal"
          ? ["exit", "abort"] // the two terminal routes (publish / deny)
          : [diagramKinds[expected]];
      expect(
        allowed,
        `edge ${edgeKey(edge)} drawn as '${edge.kind}', descriptor says '${expected}'`
      ).toContain(edge.kind);
    }
  });

  it("shows the gate node with its host-only decisions", () => {
    for (const gate of KB_FLOW.gates) {
      const node = N[gate.state];
      expect(node, `gate state '${gate.state}' is missing from the diagram`).toBeDefined();
      expect(N[gate.state].badge).toBe("HITL");
      expect([...(node.decisions ?? [])].sort()).toEqual([...gate.decisions].sort());
      expect(node.host_only).toBe(true);
    }
    // And exactly one gate state.
    const gateNodes = nodeIds.filter((id) => N[id].badge === "HITL");
    expect(gateNodes).toEqual(KB_FLOW.gates.map((g) => g.state));
  });

  it("binds every agent node to its SSOT agent", () => {
    for (const state of KB_FLOW.states) {
      if (state.kind !== "agent" || state.agent === undefined) continue;
      expect(N[state.id].who, `node '${state.id}' must name its agent`).toBe(state.agent);
      expect(N[state.id].cls).toBe(state.agent);
    }
  });

  it("retains the descriptor's bounded repairs with their feedback kinds", () => {
    const repairs = KB_FLOW.edges.filter((e) => e.kind === "repair");
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) {
      const drawn = E.find((e) => edgeKey(e) === edgeKey(repair));
      expect(drawn, `repair ${edgeKey(repair)} is missing`).toBeDefined();
      expect(drawn?.kind).toBe("loop");
      if (repair.feedback_kind !== undefined) {
        expect(String(drawn?.label ?? ""), "repair labels must carry the feedback kind").toContain(
          repair.feedback_kind
        );
        // Feedback kinds must come from the contract's feedback vocabulary.
        // (refine carries none: it is a human decision, not a machine gap kind.)
        expect(
          KNOWLEDGE_BASE_SKILL_CONTRACT.feedback_kinds,
          `repair ${edgeKey(repair)} uses an undeclared feedback kind`
        ).toContain(repair.feedback_kind);
      }
    }
    // Every agent phase can reissue itself on an incomplete result.
    for (const phase of KB_AGENT_PHASES) {
      expect(
        repairs.some((r) => r.from === phase && r.to === phase),
        `missing self-repair at '${phase}'`
      ).toBe(true);
    }
  });

  it("routes the terminals exactly as the descriptor says (completion-gate consistent)", () => {
    const requiredStates = KNOWLEDGE_BASE_SKILL_CONTRACT.completion_gate.required_states;
    for (const terminal of KB_FLOW.terminals) {
      const drawn = E.filter((e) => e.to === terminal.id);
      expect(drawn.length, `terminal '${terminal.id}' must be reachable`).toBeGreaterThan(0);
      // A met terminal's only route is the required publication state.
      if (terminal.met) {
        expect(requiredStates).toContain(terminal.route_from);
        expect(
          drawn.every((e) => e.from === terminal.route_from),
          "a met terminal must be reachable only from the required state"
        ).toBe(true);
      }
      expect(
        drawn.every((e) => e.kind === "exit" || e.kind === "abort" || e.kind === "gate"),
        `terminal '${terminal.id}' has a non-decision route in the diagram`
      ).toBe(true);
    }
  });

  it("documents the uniform cancel seam and the honest-exhaustion rule", () => {
    // The cancel seam (operator cancel from any non-terminal state) is the one
    // documented omission, per the flow-diagram standard.
    expect(html).toMatch(/omitted for legibility/i);
    expect(html).toContain("cancelled");
    // Exhaustion: budget spent → unresolved, never a faked pass.
    expect(html).toMatch(/budget spent/i);
    expect(html).toMatch(/unresolved/i);
    expect(html).toMatch(/no fake pass|never a faked pass/i);
  });

  it("is self-contained (no network, no external assets, no script execution of private data)", () => {
    expect(html).not.toMatch(/<script[^>]+src\s*=/i);
    expect(html).not.toMatch(/<link[^>]+href\s*=/i);
    const scripts =
      html.match(/<script\b(?! type="application\/json")[^>]*>[\s\S]*?<\/script>/g) ?? [];
    expect(scripts.length, "at most the one inline rendering script").toBe(1);
    const inline = scripts.join("\n");
    expect(inline).not.toMatch(/fetch\(|XMLHttpRequest|import\s+[\w"']/);
    // The SVG namespace constant is the only URL allowed (a namespace id, never a request).
    const urls = inline.match(/https?:\/\/[^\s'")]+/g) ?? [];
    expect(
      urls.filter((u) => !u.startsWith("http://www.w3.org/2000/svg")),
      `external URLs in the inline script: ${urls.join(", ")}`
    ).toEqual([]);
  });
});

const researchHtml = readFileSync(RESEARCH_FLOW_HTML, "utf8");
function researchDiagram(): { states: Set<string>; edges: Set<string> } {
  const nodeSegment = researchHtml.split("const N", 2)[1]?.split("const E", 1)[0] ?? "";
  const edgeSegment = researchHtml.split("const E", 2)[1]?.split("];", 1)[0] ?? "";
  const states = new Set(
    [...nodeSegment.matchAll(/^\s{2,}([A-Za-z_]\w*)\s*:\s*\{/gm)].map((match) => match[1])
  );
  const from = [...edgeSegment.matchAll(/\bfrom\s*:\s*'([A-Za-z_]\w*)'/g)].map((match) => match[1]);
  const to = [...edgeSegment.matchAll(/\bto\s*:\s*'([A-Za-z_]\w*)'/g)].map((match) => match[1]);
  if (from.length !== to.length) throw new Error("research flow has an unpaired edge");
  return { states, edges: new Set(from.map((source, index) => `${source}→${to[index]}`)) };
}

describe("flow-diagrams (research)", () => {
  it("draws exactly the TypeScript research descriptor states", () => {
    expect([...researchDiagram().states].sort()).toEqual([...RESEARCH_FLOW.states].sort());
  });

  it("draws exactly the TypeScript research descriptor edges", () => {
    const expected = RESEARCH_FLOW.edges.map(([from, to]) => `${from}→${to}`).sort();
    expect([...researchDiagram().edges].sort()).toEqual(expected);
  });
});
