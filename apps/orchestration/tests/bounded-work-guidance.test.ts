import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  buildCatalogPrompt,
  buildWorkerPrompt,
  loadPromptDocumentation,
  verifyPromptDocumentation,
} from "../dist/catalog-prompt.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(path.join(projectRoot, ".pi/SYSTEM.md"), "utf8");
const guidePath = "docs/agents/agents/bounded-work.md";

// Test delivery of the actual policy, not a frozen copy of its prose. These tests
// establish assembly and expansion, not that a live model obeys the assignment.
function policy(label: string): string {
  const prefix = `- **${label}:**`;
  const line = source.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`Missing shared policy: ${label}`);
  return line;
}

function role(agentName: string): string {
  const definition = readFileSync(path.join(projectRoot, ".pi/agents", `${agentName}.md`), "utf8");
  return parseFrontmatter<Record<string, unknown>>(definition).body;
}

describe("bounded work guidance delivery", () => {
  it.each(["tabitha", "skribble", "echo", "vera"])(
    "retains shared assignment policy in the real %s worker prompt",
    (agentName) => {
      const prompt = buildCatalogPrompt({
        projectRoot,
        agentName,
        role: role(agentName),
      });
      for (const label of ["Bounded assignments", "Assignment scope"]) {
        const rule = policy(label);
        expect(source.indexOf(rule)).toBeLessThan(source.indexOf("# On-Demand Protocols"));
        expect(prompt.frame).toContain(rule);
        expect(prompt.systemPrompt).toContain(rule);
      }
      expect(prompt.frame).not.toContain("# On-Demand Protocols");
      expect(prompt.frame).not.toContain("# Bounded work coordination");
      expect(prompt.systemPrompt).toContain("input_artifacts");
      expect(prompt.systemPrompt).toContain("missing_input:");
      if (agentName === "tabitha") {
        for (const prefix of ["1. **ATOMIC**", "3. **ORDERED**"]) {
          const rule = role(agentName)
            .split("\n")
            .find((line) => line.startsWith(prefix));
          if (rule === undefined) throw new Error(`Missing Tabitha contract: ${prefix}`);
          expect(prompt.appended).toContain(rule);
        }
      }
    }
  );

  it("retains scope and context guidance in an existing anonymous worker posture", () => {
    const prompt = buildWorkerPrompt({
      kind: "private_kb",
      projectRoot,
      phaseName: "query",
      phaseGuidance: "Return only the assigned query result.",
    });
    expect(prompt.frame).toContain(policy("Bounded assignments"));
    expect(prompt.frame).toContain(policy("Assignment scope"));
    expect(prompt.frame).not.toContain("# On-Demand Protocols");
  });

  it("can bind the shared guide through the existing canonical-doc mechanism", () => {
    const documentation = loadPromptDocumentation(projectRoot, [guidePath]);
    expect(documentation).toHaveLength(1);
    expect(
      verifyPromptDocumentation(
        projectRoot,
        documentation.map((document) => document.source)
      )
    ).toEqual(documentation);
    const prompt = buildCatalogPrompt({
      projectRoot,
      agentName: "tabitha",
      role: role("tabitha"),
      documentation,
    });
    const guide = readFileSync(path.join(projectRoot, guidePath), "utf8");
    expect(prompt.systemPrompt).toContain(guide);
    expect(prompt.systemPrompt.indexOf(guide)).toBeLessThan(
      prompt.systemPrompt.indexOf("<agent_boundary>")
    );
  });

  it("routes substantial-work guidance through its direct-child index", () => {
    const index = readFileSync(path.join(projectRoot, "docs/agents/agents/AGENTS.md"), "utf8");
    const routing = readFileSync(path.join(projectRoot, "docs/penny/routing-protocol.md"), "utf8");
    const invocation = readFileSync(
      path.join(projectRoot, "docs/agents/agents/invocation.md"),
      "utf8"
    );
    expect(index).toContain("(bounded-work.md): READ WHEN");
    expect(routing).toContain("(../agents/agents/bounded-work.md)");
    expect(invocation).toContain("(bounded-work.md)");
  });
});
