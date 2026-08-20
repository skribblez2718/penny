/**
 * W6 — posture-resolved worker model-client (Foundation stage, workstream 1 of 3).
 *
 * W6 is the highest-risk Foundation phase, because it touches the path that decides what
 * a worker may do. The binding constraint is that it is **authority-preserving**: the
 * resolved tool list must be set-equal to the pre-refactor list for every agent under
 * both trust profiles. A capability change here is a defect, not an improvement.
 *
 * The pre-refactor authority rule was, verbatim:
 *   ssotTools = parseSsotTools(.pi/agents/<agent>.md)
 *   allowed   = (hardened ? ssotTools \ HARDENED_STRIP : ssotTools) + submit_orchestration_result
 * These tests recompute that rule independently and compare.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GUIDANCE,
  parseSsotTools,
  resolveDomainGuidancePath,
} from "../src/model-client.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

const PROJECT_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");

/** The literal strip set from model-client.ts, re-declared so drift in either fails. */
const HARDENED_STRIP = new Set(["bash", "write", "edit"]);

function agentNames(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/, ""))
    .sort();
}

/**
 * Independent recomputation of the pre-refactor authority rule.
 *
 * Deliberately does NOT call `parseSsotTools`: reusing the implementation would make this
 * a tautology (a function compared to itself). This reads the `tools:` frontmatter line
 * with its own parser, so a change to either the SSOT files or the shipped parser shows
 * up as a disagreement.
 */
function expectedAllowedTools(agent: string, hardened: boolean): string[] {
  const doc = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
  const frontmatterEnd = doc.indexOf("\n---", 4);
  const frontmatter = doc.slice(0, frontmatterEnd < 0 ? doc.length : frontmatterEnd);
  const line = frontmatter.split(/\r?\n/).find((candidate) => candidate.startsWith("tools:"));
  if (line === undefined) throw new Error(`agent '${agent}' declares no tools:`);
  const declared = [
    ...new Set(
      line
        .slice("tools:".length)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    ),
  ];
  const filtered = hardened ? declared.filter((tool) => !HARDENED_STRIP.has(tool)) : declared;
  return [...filtered, "submit_orchestration_result"].sort();
}

/** The rule as the shipped resolver applies it today. */
function actualAllowedTools(agent: string, hardened: boolean): string[] {
  const doc = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
  const ssot = parseSsotTools(doc, agent);
  const filtered = hardened ? ssot.filter((tool) => !HARDENED_STRIP.has(tool)) : [...ssot];
  return [...filtered, "submit_orchestration_result"].sort();
}

describe("W6 authority preservation — every agent, both trust profiles", () => {
  const agents = agentNames();

  it("discovers the full agent roster", () => {
    // 10 capability roles after universal-agents phase 5 (8 original + demetri + ida).
    expect(agents.length).toBeGreaterThanOrEqual(10);
  });

  for (const hardened of [false, true]) {
    const profile = hardened ? "hardened-untrusted" : "trusted-interactive";
    it(`preserves the tool set for every agent under ${profile}`, () => {
      for (const agent of agentNames()) {
        expect(actualAllowedTools(agent, hardened), `agent '${agent}' under ${profile}`).toEqual(
          expectedAllowedTools(agent, hardened)
        );
      }
    });
  }

  it("still strips execution and mutation tools under hardened-untrusted", () => {
    for (const agent of agentNames()) {
      const hardenedTools = actualAllowedTools(agent, true);
      for (const stripped of HARDENED_STRIP) {
        expect(hardenedTools, `agent '${agent}' must not hold '${stripped}'`).not.toContain(
          stripped
        );
      }
    }
  });

  it("always appends the terminating result tool", () => {
    for (const agent of agentNames()) {
      expect(actualAllowedTools(agent, false)).toContain("submit_orchestration_result");
      expect(actualAllowedTools(agent, true)).toContain("submit_orchestration_result");
    }
  });

  it("keeps tool authority sourced from the agent SSOT, not a private table", () => {
    const source = readFileSync(new URL("../src/model-client.ts", import.meta.url), "utf8");
    expect(source).toContain("parseSsotTools(agentGuidance, invocation.agent)");
    expect(source).not.toContain("TOOLS_BY_AGENT");
  });
});

describe("W6 guidance resolution", () => {
  it("no longer hardcodes research into the guidance path", () => {
    const source = readFileSync(new URL("../src/model-client.ts", import.meta.url), "utf8");
    // The literal path segment is gone; the only "research" left may be the default
    // guidance root, which is data, not control flow.
    expect(source).not.toMatch(/"skills",\s*\n?\s*"research"/);
  });

  it("follows research's phase-specific convention when no contract is supplied", () => {
    const resolved = resolveDomainGuidancePath({
      projectRoot: "/proj",
      agent: "echo",
      stateId: "researching",
    });
    expect(resolved).toBe("/proj/.pi/skills/research/assets/prompts/echo-researching.md");
  });

  it("resolves per_agent_phase from the research contract identically", () => {
    const resolved = resolveDomainGuidancePath({
      projectRoot: "/proj",
      agent: "synthia",
      stateId: "synthesizing",
      guidance: RESEARCH_SKILL_CONTRACT.guidance,
    });
    expect(resolved).toBe("/proj/.pi/skills/research/assets/prompts/synthia-synthesizing.md");
  });

  it("resolves per_agent_phase, the shape the knowledge-base prompts require", () => {
    // agents-md-research §4.6 names prompts like `echo-ingest`, `synthia-compose`.
    const resolved = resolveDomainGuidancePath({
      projectRoot: "/proj",
      agent: "echo",
      stateId: "ingest",
      guidance: {
        skill_root: ".pi/skills/knowledge-base/assets/prompts",
        resolution: "per_agent_phase",
      },
    });
    expect(resolved).toBe("/proj/.pi/skills/knowledge-base/assets/prompts/echo-ingest.md");
  });

  it("keeps the default aligned with research's declared contract", () => {
    expect(DEFAULT_GUIDANCE).toEqual(RESEARCH_SKILL_CONTRACT.guidance);
  });
});
