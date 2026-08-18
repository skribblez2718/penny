/**
 * W12 — Research parity guard (Foundation stage, workstream 1 of 3).
 *
 * This is the authority the whole Foundation refactor is judged against. It pins
 * research's observable topology BEFORE any seam is extracted, so that W1/W2/W3/W5/W6/W7
 * cannot silently drift the parity and canary oracle that `agents-md-research` §1
 * outcome 5 makes mandatory.
 *
 * **When this fixture and the implementation disagree, the fixture wins.** Revert the
 * refactor step. Amending the pin requires an explicit prior decision — and a fixture
 * edit may never share a commit with a behaviour edit.
 *
 * Two independent detection strategies, because either alone has a blind spot:
 *
 *  1. **Behavioural** — `researchSummarySchema()` resolves every pinned state and throws
 *     for non-states. Proves the pinned names are real and that neighbours are rejected.
 *     Blind spot: an ADDED state would not be noticed.
 *  2. **Structural** — the canonical tables are extracted from `playbooks/research.ts`
 *     source text and compared for exact set/shape equality. Catches additions,
 *     removals, and rebindings.
 *
 * Source-text extraction is deliberate. `AGENT_BY_STATE`, `MODES`, and `DEFAULT_MODE` are
 * module-private and `ResearchState` is `keyof typeof AGENT_BY_STATE`, so there is no
 * runtime surface that *is* the vocabulary. Reading the declaration is the most faithful
 * available oracle, and it requires no source change — which is what makes F1 rollback
 * free of any risk to research behaviour.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { researchSummarySchema } from "../src/playbooks/research.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PIN = JSON.parse(
  readFileSync(path.join(here, "fixtures", "research-parity-pin.json"), "utf8")
) as {
  states: string[];
  agent_by_state: Record<string, string>;
  modes: { allowed: string[]; default: string };
  budget_constraints: string[];
  output_files: string[];
  terminal: { completion_state: string; completion_field: string; met_field: string };
  non_states: string[];
};

const SOURCE = readFileSync(path.join(here, "..", "src", "playbooks", "research.ts"), "utf8");

/** Extract the `AGENT_BY_STATE` object literal — the canonical state vocabulary. */
function extractAgentByState(source: string): Record<string, string> {
  const start = source.indexOf("const AGENT_BY_STATE");
  if (start < 0) throw new Error("AGENT_BY_STATE declaration not found");
  const open = source.indexOf("{", start);
  const close = source.indexOf("} as const", open);
  if (open < 0 || close < 0) throw new Error("AGENT_BY_STATE literal not delimited as expected");
  const body = source.slice(open + 1, close);
  const map: Record<string, string> = {};
  for (const [, state, agent] of body.matchAll(/([a-z_]+)\s*:\s*"([a-z]+)"/g)) {
    map[state] = agent;
  }
  if (Object.keys(map).length === 0) throw new Error("AGENT_BY_STATE parsed empty");
  return map;
}

function extractModes(source: string): { allowed: string[]; default: string } {
  const modes = source.match(/const MODES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  const fallback = source.match(/const DEFAULT_MODE\s*=\s*"([a-z]+)"/);
  if (!modes || !fallback) throw new Error("MODES / DEFAULT_MODE not found");
  return {
    allowed: [...modes[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]),
    default: fallback[1],
  };
}

/** Budget knobs research accepts from caller constraints. */
function extractBudgetConstraints(source: string): string[] {
  const names = new Set<string>();
  for (const [, name] of source.matchAll(
    /(?:boundedConstraint|positiveIntegerOrZeroConstraint)\(\s*context[^)]*?"([a-z_]+)"/g
  )) {
    names.add(name);
  }
  for (const [, name] of source.matchAll(/constraints\.(max_research_rounds|critique_passes)/g)) {
    names.add(name);
  }
  return [...names].sort();
}

function extractOutputFiles(source: string): string[] {
  const match = source.match(/\[((?:\s*"[A-Za-z.]+\.md",?)+)\]\.map/);
  if (!match) throw new Error("report output file triple not found");
  return [...match[1].matchAll(/"([A-Za-z.]+\.md)"/g)].map((m) => m[1]);
}

describe("W12 research parity pin — behavioural", () => {
  it("resolves a summary schema for every pinned state", () => {
    for (const state of PIN.states) {
      expect(() => researchSummarySchema(state), `state '${state}'`).not.toThrow();
      expect(researchSummarySchema(state)).toBeTypeOf("object");
    }
  });

  it("rejects every non-state, including plausible neighbours from other playbooks", () => {
    for (const state of PIN.non_states) {
      expect(() => researchSummarySchema(state), `non-state '${state}'`).toThrow(
        /unknown research state/
      );
    }
  });
});

describe("W12 research parity pin — structural", () => {
  it("pins the state vocabulary by exact set equality", () => {
    const actual = Object.keys(extractAgentByState(SOURCE)).sort();
    // Set equality, not subset: both an added and a removed state must fail.
    expect(actual).toEqual([...PIN.states].sort());
  });

  it("pins the state to agent binding", () => {
    expect(extractAgentByState(SOURCE)).toEqual(PIN.agent_by_state);
  });

  it("pins the mode presets and default", () => {
    const modes = extractModes(SOURCE);
    expect([...modes.allowed].sort()).toEqual([...PIN.modes.allowed].sort());
    expect(modes.default).toBe(PIN.modes.default);
  });

  it("pins the budget constraint surface", () => {
    expect(extractBudgetConstraints(SOURCE)).toEqual([...PIN.budget_constraints].sort());
  });

  it("pins the three-file report output, in order", () => {
    expect(extractOutputFiles(SOURCE)).toEqual(PIN.output_files);
  });

  it("pins terminal completion semantics", () => {
    expect(PIN.states).toContain(PIN.terminal.completion_state);
    expect(SOURCE).toContain(`${PIN.terminal.completion_field}: Type.Boolean()`);
    expect(SOURCE).toMatch(new RegExp(`context\\.${PIN.terminal.met_field}\\s*=`));
  });
});

describe("W12 parity pin — the guard itself detects drift", () => {
  // FG1 requires proof that the pin FAILS on induced drift. A pin that has never been
  // shown to fail proves nothing about the six phases it is supposed to protect.
  it("detects an added state", () => {
    const drifted = SOURCE.replace(
      'report_writing: "skribble",',
      'report_writing: "skribble",\n  ingesting: "echo",'
    );
    expect(Object.keys(extractAgentByState(drifted)).sort()).not.toEqual([...PIN.states].sort());
  });

  it("detects a removed state", () => {
    const drifted = SOURCE.replace('validating: "vera",', "");
    expect(Object.keys(extractAgentByState(drifted)).sort()).not.toEqual([...PIN.states].sort());
  });

  it("detects a rebound agent", () => {
    const drifted = SOURCE.replace('validating: "vera",', 'validating: "carren",');
    expect(extractAgentByState(drifted)).not.toEqual(PIN.agent_by_state);
  });

  it("detects a changed mode preset and a changed default", () => {
    expect(
      extractModes(SOURCE.replace('new Set(["quick", "standard", "deep"])', 'new Set(["quick"])'))
        .allowed
    ).not.toEqual(PIN.modes.allowed);
    expect(
      extractModes(SOURCE.replace('const DEFAULT_MODE = "standard"', 'const DEFAULT_MODE = "deep"'))
        .default
    ).not.toBe(PIN.modes.default);
  });

  it("detects a dropped budget knob", () => {
    const drifted = SOURCE.replace(/boundedConstraint\(context, "max_fan_width"/g, "IGNORED(");
    expect(extractBudgetConstraints(drifted)).not.toEqual([...PIN.budget_constraints].sort());
  });

  it("detects a changed report output set", () => {
    const drifted = SOURCE.replace(
      '["report.md", "sources.md", "README.md"].map',
      '["report.md", "sources.md"].map'
    );
    expect(extractOutputFiles(drifted)).not.toEqual(PIN.output_files);
  });
});
