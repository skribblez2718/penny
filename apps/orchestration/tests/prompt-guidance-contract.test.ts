/**
 * Prompt guidance is a closed, bidirectional contract with each playbook machine.
 *
 * Forward-only checks miss two dangerous forms of drift: a newly declared agent phase
 * without guidance, and an orphaned/misnamed prompt that can never resolve. These tests
 * derive the expected names from the machines and compare the complete `.md` file set in
 * each contract-declared prompt root. No filename is parsed; the production resolver
 * constructs every expected path from the declared agent/state pair.
 */

import { parseResearchParityPin } from "./helpers/fixtures.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateContract, type SkillContract } from "../src/contracts.js";
import { resolveDomainGuidancePath } from "../src/model-client.js";
import {
  ASSESS_AGENT_BY_STATE,
  ASSESS_CANDIDATE_REGISTRATION,
  ASSESS_SKILL_CONTRACT,
} from "../src/playbooks/assess.js";
import { DECIDE_AGENT_BY_STATE, DECIDE_SKILL_CONTRACT } from "../src/playbooks/decide.js";
import { DIAGNOSE_AGENT_BY_STATE, DIAGNOSE_SKILL_CONTRACT } from "../src/playbooks/diagnose.js";
import { KB_FLOW, KNOWLEDGE_BASE_SKILL_CONTRACT } from "../src/playbooks/knowledge-base.js";
import { PLAN_AGENT_BY_STATE, PLAN_SKILL_CONTRACT } from "../src/playbooks/plan.js";
import { PRODUCE_AGENT_BY_STATE, PRODUCE_SKILL_CONTRACT } from "../src/playbooks/produce.js";
import {
  parsePersistedAssessmentDraft,
  type AssessmentRequestV1,
} from "../src/skill-contracts/assess.js";
import {
  parsePersistedArtifactApproach,
  parsePersistedProducedArtifactDraft,
  type ProduceRequestV1,
} from "../src/skill-contracts/produce.js";
import { RESEARCH_SKILL_CONTRACT, researchSummarySchema } from "../src/playbooks/research.js";
import { parsePersistedRoutingSummary } from "../src/worker.js";

interface AgentPhase {
  readonly agent: string;
  readonly phase: string;
}

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PIN = parseResearchParityPin(
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
);

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
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...RESEARCH_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    for (const { agent, phase } of phases) {
      const prompt = readFileSync(path.join(promptRoot, `${agent}-${phase}.md`), "utf8");
      const example = prompt.split(/\r?\n/u).find((line) => line.startsWith("SUMMARY:"));
      if (example === undefined) throw new Error(`missing SUMMARY example for ${agent}/${phase}`);
      const routing = parsePersistedRoutingSummary(example);
      expect(routing, `${agent}/${phase}`).toBeDefined();
      expect(() =>
        validateContract(researchSummarySchema(phase), routing?.details, `${phase} prompt example`)
      ).not.toThrow();
    }
    const synthia = readFileSync(path.join(promptRoot, "synthia-synthesizing.md"), "utf8");
    expect(synthia).toContain("one closed `ResearchSemanticDraftV1` JSON value");
    expect(synthia).toContain("Use zero-based local array indexes only");
    expect(synthia).toContain("Do not emit request fields, provenance fields, stable global IDs");
    expect(synthia).toContain("Canonical JSON key order is not required at this boundary");
    expect(synthia).not.toContain("Skribble");
  });

  it("keeps Assess guidance equal to its exact Annie/Carren/Vera machine", () => {
    const phases = Object.entries(ASSESS_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(ASSESS_SKILL_CONTRACT, phases);
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...ASSESS_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    if (ASSESS_CANDIDATE_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("Assess must use catalog agents");
    }
    for (const [phase, registration] of ASSESS_CANDIDATE_REGISTRATION.worker.phases) {
      const prompt = readFileSync(
        path.join(promptRoot, `${registration.agent}-${phase}.md`),
        "utf8"
      );
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("catalog agent's YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
      const summaryExample = prompt.split(/\r?\n/u).find((line) => line.startsWith("SUMMARY:"));
      if (summaryExample === undefined) throw new Error(`missing Assess SUMMARY for ${phase}`);
      const routing = parsePersistedRoutingSummary(summaryExample);
      expect(routing, phase).toBeDefined();
      expect(() =>
        validateContract(registration.schema, routing?.details, `${phase} prompt example`)
      ).not.toThrow();
    }
    const carren = readFileSync(path.join(promptRoot, "carren-authoring_assessment.md"), "utf8");
    const draftExample = carren
      .split(/\r?\n/u)
      .find((line) => line.startsWith("ASSESSMENT_DRAFT:"));
    if (draftExample === undefined) throw new Error("Assess Carren prompt lacks draft example");
    const exampleRequest: AssessmentRequestV1 = {
      schema_version: 1,
      assessment_purpose: "Assess a supplied greeting.",
      target: "Hello.",
      criteria: [{ statement: "The target is a greeting.", importance: "required" }],
      supplied_evidence: [{ statement: "The text says Hello.", source_label: "caller" }],
      hard_constraints: [],
      non_goals: [],
      known_uncertainties: [],
    };
    expect(() =>
      parsePersistedAssessmentDraft(
        Buffer.from(`${draftExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`),
        { request: exampleRequest }
      )
    ).not.toThrow();
    expect(carren).toContain("MECHANICALLY_PROJECTED_ASSESSMENT_DRAFT_CONTRACT:");
    expect(carren).toContain("No numeric score");
    expect(carren).toContain("external_actions_performed:false");
    expect(carren).toContain("filesystem_writes_performed:false");
    expect(carren).toContain("tests_executed:false");
    expect(carren).toContain("changes_started:false");
    const vera = readFileSync(path.join(promptRoot, "vera-verifying_assessment.md"), "utf8");
    expect(vera).toContain("analysis_gap");
    expect(vera).toContain("evidence_gap");
    expect(vera).toContain("assessment_product_gap");
    expect(vera).toContain("does not replace Carren's subjective assessment judgment");
  });

  it("keeps Decide guidance exact and bounds Echo to targeted located evidence", () => {
    const phases = Object.entries(DECIDE_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(DECIDE_SKILL_CONTRACT, phases);
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...DECIDE_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    for (const file of actualPromptFiles(DECIDE_SKILL_CONTRACT)) {
      const prompt = readFileSync(path.join(promptRoot, file), "utf8");
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
    }
    const echo = readFileSync(path.join(promptRoot, "echo-gathering_decision_evidence.md"), "utf8");
    expect(echo).toContain("narrowly targeted read-only local or web evidence");
    expect(echo).toContain("provide a precise locator");
    expect(echo).toContain("bounded budget is exhausted");
    expect(echo).toContain("Report it honestly");
    expect(echo).not.toContain("no external-acquisition authority");
  });

  it("keeps Diagnose guidance equal to its exact four-phase machine", () => {
    const phases = Object.entries(DIAGNOSE_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(DIAGNOSE_SKILL_CONTRACT, phases);
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...DIAGNOSE_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    for (const file of actualPromptFiles(DIAGNOSE_SKILL_CONTRACT)) {
      const prompt = readFileSync(path.join(promptRoot, file), "utf8");
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("catalog agent's YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
      expect(prompt).toContain("begin remediation");
      expect(prompt).not.toContain("host:diagnosis-validity-receipt-authority");
    }
    const demetri = readFileSync(
      path.join(promptRoot, "demetri-adjudicating_diagnosis.md"),
      "utf8"
    );
    expect(demetri).toContain("MECHANICALLY_PROJECTED_DIAGNOSIS_DRAFT_CONTRACT:");
    expect(demetri).toContain('"hypothesis_set_complete":true');
    expect(demetri).toContain('"primary_supported_hypothesis_id":null');
    expect(demetri).toContain('"uncertainty":[]');
    expect(demetri).toContain('"problem_statement_covered":true');
    expect(demetri).toContain('"symptom_indexes":[]');
    expect(demetri).toContain('"permitted_test_boundary_covered":true');
    expect(demetri).not.toContain('"primary_cause_hypothesis_id"');
    expect(demetri).not.toContain('"blocking_unknowns"');
    expect(demetri).toContain("tests_executed:false");
    expect(demetri).toContain("remediation_started:false");
    const vera = readFileSync(path.join(promptRoot, "vera-verifying_diagnosis.md"), "utf8");
    expect(vera).toContain("diagnosis_product_gap");
    expect(vera).toContain("call Carren");
  });

  it("keeps Plan guidance exact and bounds Echo to targeted located evidence", () => {
    const phases = Object.entries(PLAN_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(PLAN_SKILL_CONTRACT, phases);
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...PLAN_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    for (const file of actualPromptFiles(PLAN_SKILL_CONTRACT)) {
      const prompt = readFileSync(path.join(promptRoot, file), "utf8");
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
    }
    const echo = readFileSync(path.join(promptRoot, "echo-gathering_strategy_evidence.md"), "utf8");
    expect(echo).toContain("narrowly targeted read-only local or web evidence");
    expect(echo).toContain("provide a precise locator");
    expect(echo).toContain("bounded budget is exhausted");
    expect(echo).toContain("Report it honestly");
    expect(echo).not.toContain("no external-acquisition authority");
  });

  it("keeps Produce guidance equal to its exact Ida/Skribble/Carren/Vera machine", () => {
    const phases = Object.entries(PRODUCE_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(PRODUCE_SKILL_CONTRACT, phases);
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...PRODUCE_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    for (const file of actualPromptFiles(PRODUCE_SKILL_CONTRACT)) {
      const prompt = readFileSync(path.join(promptRoot, file), "utf8");
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("catalog agent's YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
      expect(prompt).toContain("do not authorize filesystem mutation");
      expect(prompt).not.toContain("filesystem write is permitted");
    }
    const ida = readFileSync(path.join(promptRoot, "ida-exploring_artifact_approaches.md"), "utf8");
    const idaExample = ida.split(/\r?\n/u).find((line) => line.startsWith("ARTIFACT_APPROACH:"));
    if (idaExample === undefined) throw new Error("Produce Ida prompt lacks approach example");
    expect(() =>
      parsePersistedArtifactApproach(
        Buffer.from(`${idaExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`)
      )
    ).not.toThrow();

    const skribble = readFileSync(
      path.join(promptRoot, "skribble-materializing_artifact.md"),
      "utf8"
    );
    const draftExample = skribble
      .split(/\r?\n/u)
      .find((line) => line.startsWith("PRODUCED_ARTIFACT_DRAFT:"));
    if (draftExample === undefined) throw new Error("Produce Skribble prompt lacks draft example");
    const exampleRequest: ProduceRequestV1 = {
      schema_version: 1,
      purpose_statement: "Create a greeting artifact.",
      output_name: "artifact.txt",
      artifact_kind: "text",
      specification: [{ statement: "Include the greeting." }],
      source_material: [{ statement: "Hello." }],
      acceptance_criteria: [{ statement: "The greeting is exact." }],
      hard_constraints: [],
      non_goals: [],
      known_uncertainties: [],
    };
    expect(() =>
      parsePersistedProducedArtifactDraft(
        Buffer.from(`${draftExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`),
        { request: exampleRequest }
      )
    ).not.toThrow();
    expect(skribble).toContain("MECHANICALLY_PROJECTED_PRODUCED_ARTIFACT_DRAFT_CONTRACT:");
    expect(skribble).toContain("filesystem_writes_performed:false");
    expect(skribble).toContain("tests_executed:false");
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
