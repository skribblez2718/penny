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

import { loadPromptDocumentation } from "../dist/catalog-prompt.js";
import { validateContract, type SkillContract } from "../dist/contracts.js";
import { resolveDomainGuidancePath } from "../dist/model-client.js";
import {
  ASSESS_AGENT_BY_STATE,
  ASSESS_PLAYBOOK_REGISTRATION,
  ASSESS_SKILL_CONTRACT,
} from "../dist/playbooks/assess.js";
import {
  DECIDE_AGENT_BY_STATE,
  DECIDE_PLAYBOOK_REGISTRATION,
  DECIDE_SKILL_CONTRACT,
} from "../dist/playbooks/decide.js";
import {
  DIAGNOSE_AGENT_BY_STATE,
  DIAGNOSE_PLAYBOOK_REGISTRATION,
  DIAGNOSE_SKILL_CONTRACT,
} from "../dist/playbooks/diagnose.js";
import {
  DEFINE_AGENT_BY_STATE,
  DEFINE_PLAYBOOK_REGISTRATION,
  DEFINE_SKILL_CONTRACT,
} from "../dist/playbooks/define.js";
import {
  IMAGEGEN_PLAYBOOK_REGISTRATION,
  IMAGEGEN_SKILL_CONTRACT,
} from "../dist/playbooks/imagegen.js";
import { KB_FLOW, KNOWLEDGE_BASE_SKILL_CONTRACT } from "../dist/playbooks/knowledge-base.js";
import {
  PLAN_AGENT_BY_STATE,
  PLAN_PLAYBOOK_REGISTRATION,
  PLAN_SKILL_CONTRACT,
} from "../dist/playbooks/plan.js";
import {
  PRODUCE_AGENT_BY_STATE,
  PRODUCE_PLAYBOOK_REGISTRATION,
  PRODUCE_SKILL_CONTRACT,
} from "../dist/playbooks/produce.js";
import type { PlaybookRegistration } from "../dist/playbooks/registry.js";
import { SCA_PLAYBOOK_REGISTRATION, SCA_SKILL_CONTRACT } from "../dist/playbooks/sca.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { ScaReviewSchema } from "../dist/sca/ordinary-contracts.js";
import {
  parsePersistedAssessmentDraftV2,
  type AssessmentRequestV1,
} from "../dist/skill-contracts/assess.js";
import { DecisionCoreV2Schema } from "../dist/skill-contracts/decide.js";
import { DiagnosisCoreV1Schema } from "../dist/skill-contracts/diagnose.js";
import {
  ArtifactApproachDecisionV1Schema,
  ArtifactApproachV1Schema,
  parsePersistedArtifactApproach,
  parsePersistedArtifactApproachDecision,
  parsePersistedProducedArtifactDraftV2,
  type ProduceRequestV1,
} from "../dist/skill-contracts/produce.js";
import { RESEARCH_SKILL_CONTRACT, researchSummarySchema } from "../dist/playbooks/research.js";
import { parsePersistedRoutingSummary } from "../dist/worker.js";

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

function expectSummaryExamplesMatchRegistration(
  name: string,
  contract: SkillContract,
  registration: PlaybookRegistration
): void {
  if (registration.worker.kind !== "catalog-agent") {
    throw new Error(`${name} must use catalog agents`);
  }
  const promptRoot = path.join(PROJECT_ROOT, ...contract.guidance.skill_root.split("/"));
  for (const [phase, phaseRegistration] of registration.worker.phases) {
    const guidancePhase = phaseRegistration.guidance_state_id ?? phase;
    const prompt = readFileSync(
      path.join(promptRoot, `${phaseRegistration.agent}-${guidancePhase}.md`),
      "utf8"
    );
    if (phaseRegistration.result_projection !== undefined) {
      expect(prompt).toContain(phaseRegistration.result_projection.declaration.schema_id);
      expect(prompt).toContain("Host-owned SUMMARY projection");
      expect(prompt).toContain("do not duplicate it in a model-authored SUMMARY");
      expect(prompt).not.toContain("Emit exactly two lines");
    }
    // Opted-in phases may still document an optional redundant closed example.
    const summaryExample = prompt.split(/\r?\n/u).find((line) => line.startsWith("SUMMARY:"));
    if (summaryExample === undefined) {
      throw new Error(`missing ${name} SUMMARY for ${phase}`);
    }
    const routing = parsePersistedRoutingSummary(summaryExample);
    expect(routing, `${name}/${phase}`).toBeDefined();
    expect(() =>
      validateContract(
        phaseRegistration.schema,
        routing?.details,
        `${name}/${phase} prompt example`
      )
    ).not.toThrow();
  }
}

function expectTypedCritiqueFindingsGuidance(prompt: string, name: string): void {
  expect(prompt, name).toContain("`findings` is a JSON array of objects, never strings");
  expect(prompt, name).toContain(
    '{"severity":"minor","message":"One evidence-linked nonblocking issue."}'
  );
}

describe("closed prompt-guidance surfaces", () => {
  it("keeps every raw machine-footer example as concrete JSON rather than pseudo-JSON", () => {
    const skillsRoot = path.join(PROJECT_ROOT, ".pi", "skills");
    for (const skill of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const promptRoot = path.join(skillsRoot, skill.name, "assets", "prompts");
      let files: readonly string[];
      try {
        files = readdirSync(promptRoot).filter((entry) => entry.endsWith(".md"));
      } catch {
        continue;
      }
      for (const file of files) {
        const prompt = readFileSync(path.join(promptRoot, file), "utf8");
        for (const line of prompt.split(/\r?\n/u)) {
          if (!/^[A-Z_]+:\{/u.test(line)) continue;
          const separator = line.indexOf(":");
          expect(
            () => {
              JSON.parse(line.slice(separator + 1));
            },
            `${skill.name}/${file}: ${line.slice(0, separator)}`
          ).not.toThrow();
        }
      }
    }
  });

  it("declares exact existing canonical writing documents for every registered workflow", () => {
    const workflows = [
      ["assess", ASSESS_SKILL_CONTRACT],
      ["decide", DECIDE_SKILL_CONTRACT],
      ["diagnose", DIAGNOSE_SKILL_CONTRACT],
      ["define", DEFINE_SKILL_CONTRACT],
      ["plan", PLAN_SKILL_CONTRACT],
      ["produce", PRODUCE_SKILL_CONTRACT],
      ["research", RESEARCH_SKILL_CONTRACT],
      ["knowledge-base", KNOWLEDGE_BASE_SKILL_CONTRACT],
      ["imagegen", IMAGEGEN_SKILL_CONTRACT],
      ["sca", SCA_SKILL_CONTRACT],
    ] as const;
    for (const [name, contract] of workflows) {
      const declarations = contract.guidance.documentation;
      expect(declarations, name).toBeDefined();
      const documents = loadPromptDocumentation(PROJECT_ROOT, declarations);
      expect(
        documents.map((document) => document.source.path),
        name
      ).toEqual(declarations);
      expect(documents.every((document) => /^[a-f0-9]{64}$/u.test(document.source.sha256))).toBe(
        true
      );
      expect(declarations, name).toContain("docs/agents/writing/standard.md");
      expect(declarations, name).toContain("docs/agents/writing/review.md");
    }
    expect(RESEARCH_SKILL_CONTRACT.guidance.documentation).toContain(
      "docs/agents/writing/genres/research.md"
    );
  });

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
    if (ASSESS_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("Assess must use catalog agents");
    }
    for (const [phase, registration] of ASSESS_PLAYBOOK_REGISTRATION.worker.phases) {
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
      parsePersistedAssessmentDraftV2(
        Buffer.from(`${draftExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`),
        { request: exampleRequest }
      )
    ).not.toThrow();
    expect(carren).toContain("MECHANICALLY_PROJECTED_ASSESSMENT_DRAFT_CONTRACT:");
    expect(carren).toContain("No numeric score");
    expect(carren).toContain("effect claims");
    expect(carren).not.toContain("external_actions_performed:false");
    expect(carren).not.toContain("filesystem_writes_performed:false");
    expect(carren).not.toContain("tests_executed:false");
    expect(carren).not.toContain("changes_started:false");
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
    expectSummaryExamplesMatchRegistration(
      "Decide",
      DECIDE_SKILL_CONTRACT,
      DECIDE_PLAYBOOK_REGISTRATION
    );
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
    const critic = readFileSync(path.join(promptRoot, "carren-critiquing_decision.md"), "utf8");
    expectTypedCritiqueFindingsGuidance(critic, "Decide/Carren");
    const demetri = readFileSync(path.join(promptRoot, "demetri-deciding.md"), "utf8");
    const decisionCoreExample = demetri
      .split(/\r?\n/u)
      .find((line) => line.startsWith("DECISION_CORE:"));
    if (decisionCoreExample === undefined) {
      throw new Error("Decide Demetri prompt lacks decision-core example");
    }
    const parsedDecisionCore: unknown = JSON.parse(
      decisionCoreExample.slice("DECISION_CORE:".length)
    );
    expect(() =>
      validateContract(
        DecisionCoreV2Schema,
        parsedDecisionCore,
        "Decide Demetri prompt core example"
      )
    ).not.toThrow();
  });

  it("keeps Diagnose guidance equal to its exact four-phase machine", () => {
    const phases = Object.entries(DIAGNOSE_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(DIAGNOSE_SKILL_CONTRACT, phases);
    expectSummaryExamplesMatchRegistration(
      "Diagnose",
      DIAGNOSE_SKILL_CONTRACT,
      DIAGNOSE_PLAYBOOK_REGISTRATION
    );
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
    const diagnosisCoreExample = demetri
      .split(/\r?\n/u)
      .find((line) => line.startsWith("DIAGNOSIS_CORE:"));
    if (diagnosisCoreExample === undefined) {
      throw new Error("Diagnose Demetri prompt lacks diagnosis-core example");
    }
    const parsedDiagnosisCore: unknown = JSON.parse(
      diagnosisCoreExample.slice("DIAGNOSIS_CORE:".length)
    );
    expect(() =>
      validateContract(
        DiagnosisCoreV1Schema,
        parsedDiagnosisCore,
        "Diagnose Demetri prompt core example"
      )
    ).not.toThrow();
    expect(demetri).toContain('"hypothesis_set_complete":true');
    expect(demetri).toContain('"primary_supported_hypothesis_id":null');
    expect(demetri).toContain('"uncertainty":[]');
    expect(demetri).toContain('"problem_statement_covered":true');
    expect(demetri).toContain('"symptom_indexes":[0]');
    expect(demetri).toContain('"permitted_test_boundary_covered":true');
    expect(demetri).not.toContain('"primary_cause_hypothesis_id"');
    expect(demetri).not.toContain('"blocking_unknowns"');
    expect(demetri).toContain("tests_executed:false");
    expect(demetri).toContain("remediation_started:false");
    const vera = readFileSync(path.join(promptRoot, "vera-verifying_diagnosis.md"), "utf8");
    expect(vera).toContain("diagnosis_product_gap");
    expect(vera).toContain("call Carren");
  });

  it("keeps Define guidance equal to its exact Piper/Echo/Rhea/Vera/Carren machine", () => {
    const phases = Object.entries(DEFINE_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(DEFINE_SKILL_CONTRACT, phases);
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...DEFINE_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    if (DEFINE_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("Define must use catalog agents");
    }
    for (const [phase, registration] of DEFINE_PLAYBOOK_REGISTRATION.worker.phases) {
      const prompt = readFileSync(
        path.join(promptRoot, `${registration.agent}-${phase}.md`),
        "utf8"
      );
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("catalog agent's YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
      expect(prompt).toMatch(/execute|execution/u);
      const summaryExample = prompt.split(/\r?\n/u).find((line) => line.startsWith("SUMMARY:"));
      if (summaryExample === undefined) throw new Error(`missing Define SUMMARY for ${phase}`);
      const routing = parsePersistedRoutingSummary(summaryExample);
      expect(routing, phase).toBeDefined();
      expect(() =>
        validateContract(registration.schema, routing?.details, `${phase} prompt example`)
      ).not.toThrow();
    }
    const author = readFileSync(path.join(promptRoot, "rhea-authoring_specification.md"), "utf8");
    expect(author).toContain("MECHANICALLY_PROJECTED_SPECIFICATION_DRAFT_CONTRACT:");
    expect(author).toContain("full replacement");
    expect(author).toContain("planning, taskification, execution");
    expect(author).toContain("required_requirement_categories");
    expect(author).toContain("requirement.category` is scalar");
    expect(author).toContain("never fix one absence by removing or renaming another");
    expect(author).toContain("sole model-authored source-to-product relation");
    expect(author).toContain("Omit compatibility-only draft `product_item_refs`");
    expect(author).toContain("host ignores supplied values");
    expect(author).toContain("fix the authoritative item-side links or source dispositions");
    expect(author).toContain("latest same-run sealed specification");
    expect(author).toContain("In `create`, emit `supersession_intents: []`");
    expect(author).toContain("same-run sealed specification is the product under repair");
    expect(author).toContain("whole reported defect class");
    expect(author).toContain("Do not claim complete schemas");
    const verifier = readFileSync(path.join(promptRoot, "vera-verifying_specification.md"), "utf8");
    expect(verifier).toContain("Review the complete applicable contract");
    expect(verifier).toContain("older PASS never approves a changed product");
    const critic = readFileSync(
      path.join(promptRoot, "carren-critiquing_specification.md"),
      "utf8"
    );
    expect(critic).toContain("optional refinements remain nonblocking");
    expectTypedCritiqueFindingsGuidance(critic, "Define/Carren");
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
    if (PLAN_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("Plan must use catalog agents");
    }
    for (const [phase, registration] of PLAN_PLAYBOOK_REGISTRATION.worker.phases) {
      const prompt = readFileSync(
        path.join(promptRoot, `${registration.agent}-${phase}.md`),
        "utf8"
      );
      expect(prompt).toContain("`artifact_read` is mandatory");
      expect(prompt).toContain("YAML surface");
      expect(prompt).not.toMatch(/only `artifact_read` is active/iu);
      expect(prompt).toContain("Do not claim persistence");
      const summaryExample = prompt.split(/\r?\n/u).find((line) => line.startsWith("SUMMARY:"));
      expect(prompt).toContain("plan-specification-source-index");
      expect(prompt).toContain("PlanSpecificationSourceIndexV1");
      expect(prompt).toContain("`missing_input:`");
      expect(prompt).not.toContain("MECHANICALLY_PROJECTED_SPECIFICATION_SOURCE_ITEMS");
      if (summaryExample === undefined) throw new Error(`missing Plan SUMMARY for ${phase}`);
      const routing = parsePersistedRoutingSummary(summaryExample);
      expect(routing, phase).toBeDefined();
      expect(() =>
        validateContract(registration.schema, routing?.details, `${phase} prompt example`)
      ).not.toThrow();
    }
    const strategist = readFileSync(path.join(promptRoot, "piper-strategizing.md"), "utf8");
    expect(strategist).toContain("each request desired-outcome index appears exactly once");
    expect(strategist).toContain("never duplicate one across strategy outcomes");
    expect(strategist).toContain("PlanSpecificationSourceIndexV1");
    expect(strategist).toContain("plan-specification-source-index");
    expect(strategist).not.toContain("MECHANICALLY_PROJECTED_SPECIFICATION_SOURCE_ITEMS");
    expect(strategist).toContain("objectives and acceptance criteria");
    expect(strategist).toContain("never both");
    const echo = readFileSync(path.join(promptRoot, "echo-gathering_strategy_evidence.md"), "utf8");
    expect(echo).toContain("narrowly targeted read-only local or web evidence");
    expect(echo).toContain("provide a precise locator");
    expect(echo).toContain("bounded budget is exhausted");
    expect(echo).toContain("Report it honestly");
    expect(echo).not.toContain("no external-acquisition authority");
    const critic = readFileSync(path.join(promptRoot, "carren-critiquing_strategy.md"), "utf8");
    expectTypedCritiqueFindingsGuidance(critic, "Plan/Carren");
  });

  it("keeps Produce guidance equal to its exact Ida/Demetri/Skribble/Carren/Vera machine", () => {
    const phases = Object.entries(PRODUCE_AGENT_BY_STATE).map(([phase, agent]) => ({
      agent,
      phase,
    }));
    expectClosedPromptSurface(PRODUCE_SKILL_CONTRACT, phases);
    expectSummaryExamplesMatchRegistration(
      "Produce",
      PRODUCE_SKILL_CONTRACT,
      PRODUCE_PLAYBOOK_REGISTRATION
    );
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
    const critic = readFileSync(path.join(promptRoot, "carren-critiquing_artifact.md"), "utf8");
    expectTypedCritiqueFindingsGuidance(critic, "Produce/Carren");
    const ida = readFileSync(path.join(promptRoot, "ida-exploring_artifact_approaches.md"), "utf8");
    const idaExample = ida.split(/\r?\n/u).find((line) => line.startsWith("ARTIFACT_APPROACH:"));
    if (idaExample === undefined) throw new Error("Produce Ida prompt lacks approach example");
    const parsedApproach = parsePersistedArtifactApproach(
      Buffer.from(`${idaExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`)
    ).approach;
    expect(ida).toContain("Do not rank, score, recommend, select");
    expect(ida).toContain(
      "Use one approach when the brief and host output contract fully determine"
    );
    expect(ida).toContain("canonical JSON");
    expect(ida).not.toContain("recommend exactly one");
    const onlyApproach = parsedApproach.approaches[0];
    if (onlyApproach === undefined) throw new Error("Produce Ida example has no approach");
    expect(() =>
      validateContract(
        ArtifactApproachV1Schema,
        { ...parsedApproach, approaches: [onlyApproach] },
        "single fully determined approach"
      )
    ).not.toThrow();
    const idaRole = readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "ida.md"), "utf8");
    expect(idaRole).toMatch(/^selects: no$/mu);

    const demetri = readFileSync(
      path.join(promptRoot, "demetri-selecting_artifact_approach.md"),
      "utf8"
    );
    const decisionExample = demetri
      .split(/\r?\n/u)
      .find((line) => line.startsWith("ARTIFACT_APPROACH_DECISION:"));
    if (decisionExample === undefined) {
      throw new Error("Produce Demetri prompt lacks decision example");
    }
    expect(() =>
      parsePersistedArtifactApproachDecision(
        Buffer.from(
          `${decisionExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true,"disposition":"selected"}`
        ),
        { approach: parsedApproach }
      )
    ).not.toThrow();
    expect(demetri).toContain("what would change it");
    expect(demetri).toContain("honest unresolved disposition");
    expect(demetri).toContain("Every `approach_assessments` row must contain");
    expect(demetri).toContain("differs only incidentally");
    expect(() =>
      validateContract(
        ArtifactApproachDecisionV1Schema,
        {
          schema_version: 1,
          disposition: "selected",
          approach_assessments: [
            {
              approach_id: onlyApproach.approach_id,
              feasibility: "feasible",
              comparison: "The exact brief fully determines this sole compliant approach.",
            },
          ],
          selected_approach_id: onlyApproach.approach_id,
          rationale: "The sole feasible approach satisfies the exact brief.",
          sensitivity: ["A material change to the brief could introduce another approach."],
          blocking_questions: [],
          confidence: "PROBABLE",
        },
        "single fully determined approach decision"
      )
    ).not.toThrow();
    const demetriRole = readFileSync(
      path.join(PROJECT_ROOT, ".pi", "agents", "demetri.md"),
      "utf8"
    );
    expect(demetriRole).toMatch(/^selects: yes$/mu);

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
      parsePersistedProducedArtifactDraftV2(
        Buffer.from(`${draftExample}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`),
        { request: exampleRequest }
      )
    ).not.toThrow();
    expect(skribble).toContain("MECHANICALLY_PROJECTED_PRODUCED_ARTIFACT_DRAFT_CONTRACT:");
    expect(skribble).toContain("effect claims");
    expect(skribble).not.toContain("filesystem_writes_performed:false");
    expect(skribble).not.toContain("tests_executed:false");
  });

  it("keeps SCA guidance equal to only its active ordinary phases and schemas", () => {
    if (SCA_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("SCA must use catalog agents");
    }
    const phases = [...SCA_PLAYBOOK_REGISTRATION.worker.phases].map(([phase, registration]) => ({
      agent: registration.agent,
      phase: registration.guidance_state_id ?? phase,
    }));
    expectClosedPromptSurface(SCA_SKILL_CONTRACT, phases);
    // Reviews declare the exact schema/transport below without a copyable verdict example.
    const examplePhases = new Map(
      [...SCA_PLAYBOOK_REGISTRATION.worker.phases].filter(
        ([, registration]) => canonicalJson(registration.schema) !== canonicalJson(ScaReviewSchema)
      )
    );
    expectSummaryExamplesMatchRegistration("SCA", SCA_SKILL_CONTRACT, {
      ...SCA_PLAYBOOK_REGISTRATION,
      worker: { ...SCA_PLAYBOOK_REGISTRATION.worker, phases: examplePhases },
    });
  });

  it("aligns every SCA review-kind template with the closed review contract and complete exact reads", () => {
    if (SCA_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent")
      throw new Error("SCA must use catalog agents");
    const reviews = [...SCA_PLAYBOOK_REGISTRATION.worker.phases].filter(
      ([, registration]) => canonicalJson(registration.schema) === canonicalJson(ScaReviewSchema)
    );
    expect(reviews.map(([phase]) => phase)).toEqual([
      "reviewing_report",
      "verifying_final_product",
    ]);
    for (const [phase, registration] of reviews) {
      const prompt = readFileSync(
        path.join(
          PROJECT_ROOT,
          SCA_SKILL_CONTRACT.guidance.skill_root,
          `${registration.agent}-${registration.guidance_state_id ?? phase}.md`
        ),
        "utf8"
      );
      const embedded: unknown = JSON.parse(
        prompt.split("```json\n")[1]?.split("\n```")[0] ?? "null"
      );
      expect(embedded, phase).toEqual(JSON.parse(JSON.stringify(ScaReviewSchema)));
      for (const field of Object.keys(ScaReviewSchema.properties))
        expect(prompt, phase).toContain(`\`${field}\``);
      expect(prompt, phase).toContain("PASS requires all six checks true and `issues: []`");
      expect(prompt, phase).toContain("There is no review `gaps`, `rationale` or notes field");
      expect(prompt, phase).toContain("return a genuine GAP");
      expect(prompt, phase).toContain(
        "Ordinary scope limitations belong in the checked existing report narrative"
      );
      expect(prompt, phase).toContain("handled by the existing worker");
      expect(prompt, phase).not.toContain("this stage's gaps");
      expect(prompt, phase).not.toContain("existing rationale, reason, gaps or issues field");
      expect(prompt, phase).toContain("entire canonical report and all representations");
      expect(prompt, phase).toContain("exact next_range together");
      expect(prompt, phase).toContain("range equal to the returned next_range object UNCHANGED");
      expect(prompt, phase).toContain(
        "Distinct IDs with identical bodies still need their own exact reads"
      );
      expect(prompt, phase).toContain(
        "host representation-validation result for deterministic equality, not as proof of semantic truth"
      );
      expect(prompt, phase).toContain("A size failure never authorizes a forced PASS");
      expect(prompt, phase).toContain("complete actual representation against the active contract");
      expect(prompt, phase).toContain("exact artifact and JSON Pointer");
      expect(prompt, phase).toContain("the requirement that applies there");
      expect(prompt, phase).toContain("Do not invent mandatory capability entries");
      expect(prompt, phase).toContain(
        "evaluate the latest claim against the evidence now supplied"
      );
      expect(prompt, phase).toContain(
        "locate both the current assertion and the conflicting evidence"
      );
      expect(prompt, phase).toContain("These are the only two output lines");
      expect(prompt, phase).toContain("same complete schema fields plus `confidence`");
      expect(prompt, phase).toContain("NOTHING may follow the final SUMMARY line");
      expect(prompt, phase).not.toMatch(/^SUMMARY:/mu);
    }
  });

  it.each([
    "skribble-materializing_report.md",
    "carren-reviewing_report.md",
    "vera-verifying_final_product.md",
  ])(
    "grounds %s accounting and advisory need in the supplied records rather than fixture counts",
    (file) => {
      const prompt = readFileSync(
        path.join(PROJECT_ROOT, SCA_SKILL_CONTRACT.guidance.skill_root, file),
        "utf8"
      );
      expect(prompt).toContain("Count each set from its own array");
      expect(prompt).toContain(
        "Zero formed hypotheses or findings does not make a nonempty lead/candidate pool empty"
      );
      expect(prompt).toContain("it is not a formal `refuted` disposition");
      expect(prompt).toContain("no OSV query was needed, not a required-coverage failure");
      expect(prompt).toContain("Unresolved coordinates, failed/partial capabilities");
      expect(prompt).toContain("without erasing their origin records");
    }
  );

  it("keeps Imagegen guidance equal to its exact Annie/Synthia/Vera/Carren machine", () => {
    if (IMAGEGEN_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("Imagegen must use catalog agents");
    }
    const phases = [...IMAGEGEN_PLAYBOOK_REGISTRATION.worker.phases].map(
      ([phase, registration]) => ({
        agent: registration.agent,
        phase: registration.guidance_state_id ?? phase,
      })
    );
    expectClosedPromptSurface(IMAGEGEN_SKILL_CONTRACT, phases);
    expectSummaryExamplesMatchRegistration(
      "Imagegen",
      IMAGEGEN_SKILL_CONTRACT,
      IMAGEGEN_PLAYBOOK_REGISTRATION
    );
    const promptRoot = path.join(
      PROJECT_ROOT,
      ...IMAGEGEN_SKILL_CONTRACT.guidance.skill_root.split("/")
    );
    for (const [phase, registration] of IMAGEGEN_PLAYBOOK_REGISTRATION.worker.phases) {
      const prompt = readFileSync(
        path.join(
          promptRoot,
          `${registration.agent}-${registration.guidance_state_id ?? phase}.md`
        ),
        "utf8"
      );
      expect(registration.allowed_tools).toEqual(["artifact_read"]);
      expect(prompt).toContain("exact");
      expect(prompt).toContain("`artifact_read`");
      expect(prompt).toContain("`next_range`");
      expect(prompt).toContain("memory");
      expect(prompt).toContain("`/tmp`");
      expect(prompt).toContain("repository search");
      expect(prompt).toContain("conversation history");
      expect(prompt).toContain("name-only pointer");
      expect(prompt).toContain("missing_input:");
      expect(prompt).toContain("The owner captures and persists your output");
      expect(prompt).toContain("Do not claim persistence");
      expect(prompt).toContain("Do not write files");
      expect(prompt).toMatch(/^IMAGE_[A-Z_]+:/mu);
      expect(prompt).toMatch(/^SUMMARY:/mu);
      expect(prompt).not.toMatch(/endpoint URL|filesystem root|model file/iu);
    }
    expect(
      IMAGEGEN_PLAYBOOK_REGISTRATION.worker.phases.get("critiquing_candidates_vera")
    ).toMatchObject({ requires_image_input: true });
    expect(
      IMAGEGEN_PLAYBOOK_REGISTRATION.worker.phases.get("critiquing_candidates_carren")
    ).toMatchObject({ requires_image_input: true });
    const composing = readFileSync(path.join(promptRoot, "synthia-composing.md"), "utf8");
    expect(composing).toContain("byte-for-byte");
    expect(composing).toContain("wordless image");
    const vera = readFileSync(path.join(promptRoot, "vera-critiquing_candidates.md"), "utf8");
    const carren = readFileSync(path.join(promptRoot, "carren-critiquing_candidates.md"), "utf8");
    expect(vera).toMatch(/visually inspect every exact current/iu);
    expect(carren).toContain("total ranking");
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
