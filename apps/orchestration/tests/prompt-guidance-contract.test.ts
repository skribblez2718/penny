/**
 * Prompt guidance is a closed, bidirectional contract with each playbook machine.
 *
 * Forward-only checks miss two dangerous forms of drift: a newly declared agent phase
 * without guidance, and an orphaned/misnamed prompt that can never resolve. These tests
 * derive the expected names from the machines and compare the complete `.md` file set in
 * each contract-declared prompt root. No filename is parsed; the production resolver
 * constructs every expected path from the declared agent/state pair.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SkillContract } from "../src/contracts.js";
import { resolveDomainGuidancePath } from "../src/model-client.js";
import { KB_FLOW, KNOWLEDGE_BASE_SKILL_CONTRACT } from "../src/playbooks/knowledge-base.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

interface AgentPhase {
  readonly agent: string;
  readonly phase: string;
}

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PIN = JSON.parse(
  readFileSync(
    path.join(
      PROJECT_ROOT,
      "apps",
      "orchestration",
      "tests",
      "fixtures",
      "research-parity-pin.json"
    ),
    "utf8"
  )
) as { agent_by_state: Record<string, string> };

function expectedPromptFiles(contract: SkillContract, phases: readonly AgentPhase[]): string[] {
  return [
    ...new Set(
      phases.map(({ agent, phase }) =>
        path.basename(
          resolveDomainGuidancePath({
            projectRoot: PROJECT_ROOT,
            agent,
            stateId: phase,
            guidance: contract.guidance,
          })
        )
      )
    ),
  ].sort();
}

function actualPromptFiles(contract: SkillContract): string[] {
  const root = path.join(PROJECT_ROOT, ...contract.guidance.skill_root.split("/"));
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
}

function expectClosedPromptSurface(contract: SkillContract, phases: readonly AgentPhase[]): void {
  // Exact set equality is bidirectional: missing and orphaned/misnamed prompts fail.
  expect(actualPromptFiles(contract)).toEqual(expectedPromptFiles(contract, phases));
}

describe("closed prompt-guidance surfaces", () => {
  it("keeps research guidance equal to its parity-pinned state/agent machine", () => {
    const phases = Object.entries(PIN.agent_by_state).map(([phase, agent]) => ({ agent, phase }));
    expectClosedPromptSurface(RESEARCH_SKILL_CONTRACT, phases);
  });

  it("keeps knowledge-base guidance equal to every agent state in KB_FLOW", () => {
    const phases = KB_FLOW.states
      .filter(
        (state): state is typeof state & { agent: string } =>
          state.kind === "agent" && state.agent !== undefined
      )
      .map((state) => ({ agent: state.agent, phase: state.id }));
    expectClosedPromptSurface(KNOWLEDGE_BASE_SKILL_CONTRACT, phases);
    expect(phases).toContainEqual({ agent: "synthia", phase: "query" });

    const promptRoot = path.join(
      PROJECT_ROOT,
      ...KNOWLEDGE_BASE_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    const queryPrompt = readFileSync(path.join(promptRoot, "synthia-query.md"), "utf8");
    expect(queryPrompt).toContain("read_phase_brief({schema_version:1})");
    expect(queryPrompt).toContain("search_selected_kb({schema_version:1})");
    expect(queryPrompt).toContain("read_selected_page");
    expect(queryPrompt).not.toContain("read_query_request");
    expect(queryPrompt).not.toContain("search_selected_generation");
    const veraPrompt = readFileSync(path.join(promptRoot, "vera-verify.md"), "utf8");
    expect(veraPrompt).toContain("citation_findings");
    expect(veraPrompt).toContain("`citation_findings` entry per answer citation");

    for (const file of actualPromptFiles(KNOWLEDGE_BASE_SKILL_CONTRACT)) {
      const prompt = readFileSync(path.join(promptRoot, file), "utf8");
      expect(prompt).toContain("stage_run_artifact");
      expect(prompt).toContain("submit_phase_result");
      expect(prompt).toContain("body-free");
      expect(prompt).toContain(
        "Start with `read_phase_brief({schema_version:1})` before any other action"
      );
      expect(prompt).toContain("returned `artifact`");
      expect(prompt).toContain("copied exactly");
      expect(prompt).toMatch(/bounded schema or\s+validation\s+error/u);
      expect(prompt).toContain("only successful termination");
      expect(prompt).not.toContain('"byte_length": 0');
      expect(prompt).not.toContain("read_phase_output");
    }
  });
});
