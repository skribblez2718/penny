import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  DECIDE_CANDIDATE_REGISTRATION,
  DECIDE_EVALUATION_ABLATION_REGISTRY,
  PLAYBOOK_REGISTRY,
  resolveEvaluationCandidate,
  skillContractSha256,
} from "@penny/orchestration/source";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { resolveSkillIngress } from "../../candidate-config.js";
import {
  checkSkillPackage,
  discoverSkillsFromDirectory,
  modelInvocableSkills,
  validateUnifiedSkillRegistryPackages,
} from "../../skill-discovery.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);

describe("model-visible source-defined decide candidate", () => {
  it("is model-visible but remains outside production and disabled without host config", () => {
    const skillsDir = path.join(PROJECT_ROOT, ".pi", "skills");
    const disabledProjectRoot = path.join(PROJECT_ROOT, ".candidate-config-disabled-fixture");
    const packages = discoverSkillsFromDirectory(skillsDir);
    const packageCheck = checkSkillPackage({
      skillsDir,
      name: "decide",
      expectedReleaseStatus: "candidate",
      discoveredSkills: packages,
    });
    expect(packageCheck).toMatchObject({ ok: true });
    expect(
      validateUnifiedSkillRegistryPackages({
        skillsDir,
        productionRegistry: PLAYBOOK_REGISTRY,
        candidateRegistry: CANDIDATE_PLAYBOOK_REGISTRY,
        discoveredSkills: packages,
      }).map((skill) => skill.name)
    ).toEqual(["assess", "decide", "diagnose", "knowledge-base", "plan", "produce", "research"]);
    const missingCandidate = new Map(CANDIDATE_PLAYBOOK_REGISTRY);
    missingCandidate.delete("decide");
    expect(() =>
      validateUnifiedSkillRegistryPackages({
        skillsDir,
        productionRegistry: PLAYBOOK_REGISTRY,
        candidateRegistry: missingCandidate,
        discoveredSkills: packages,
      })
    ).toThrow(/no exact release registry binding/u);
    expect(PLAYBOOK_REGISTRY.has("decide")).toBe(false);
    expect(packages.find((skill) => skill.name === "decide")).toMatchObject({
      releaseStatus: "candidate",
      disableModelInvocation: false,
    });
    expect(modelInvocableSkills(packages).map((skill) => skill.name)).toContain("decide");
    const native = loadSkills({
      cwd: PROJECT_ROOT,
      agentDir: path.join(PROJECT_ROOT, ".native-discovery-test-agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(native.skills.map((skill) => skill.name).sort()).toEqual([
      "assess",
      "decide",
      "diagnose",
      "knowledge-base",
      "plan",
      "produce",
      "research",
    ]);
    expect(existsSync(path.join(PROJECT_ROOT, ".pi", "skills", "decide"))).toBe(true);
    expect(existsSync(path.join(disabledProjectRoot, ".pi", "candidate-enablement.json"))).toBe(
      false
    );
    expect(
      resolveSkillIngress({ projectRoot: disabledProjectRoot, skillsDir, name: "decide" })
    ).toMatchObject({
      ok: false,
      code: "CANDIDATE_DISABLED",
    });
  });

  it("resolves only through exact evaluation digest and keeps unsealed separate", () => {
    const digest = skillContractSha256(DECIDE_CANDIDATE_REGISTRATION.contract);
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);
    expect(resolveEvaluationCandidate({ name: "decide", contract_sha256: digest })).toBe(
      DECIDE_CANDIDATE_REGISTRATION
    );
    expect(
      resolveEvaluationCandidate({ name: "decide", contract_sha256: "0".repeat(64) })
    ).toBeUndefined();
    expect([...DECIDE_EVALUATION_ABLATION_REGISTRY.keys()]).toEqual(["decide-unsealed"]);
    const ablation = DECIDE_EVALUATION_ABLATION_REGISTRY.get("decide-unsealed");
    if (ablation?.worker.kind !== "catalog-agent") {
      throw new Error("Decide evaluation ablation must use a catalog agent");
    }
    expect([...ablation.worker.phases.values()].map((phase) => phase.allowed_tools)).toEqual([
      ["artifact_read"],
    ]);
    expect(CANDIDATE_PLAYBOOK_REGISTRY.has("decide-unsealed")).toBe(false);
  });

  it("omits allowed_tools from all five phases so each exact catalog YAML surface applies", () => {
    const worker = DECIDE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("decide must use catalog agents");
    const expectedPhases = [
      ["analyzing_decision", "annie"],
      ["gathering_decision_evidence", "echo"],
      ["deciding", "demetri"],
      ["verifying_decision", "vera"],
      ["critiquing_decision", "carren"],
    ];
    expect([...worker.phases.entries()].map(([phase, binding]) => [phase, binding.agent])).toEqual(
      expectedPhases
    );
    for (const phase of worker.phases.values()) {
      expect(phase).not.toHaveProperty("allowed_tools");
    }
    expect(worker.guidance).toEqual({
      skill_root: ".pi/skills/decide/assets/prompts",
      resolution: "per_agent_phase",
    });
    for (const [phaseName, agent] of expectedPhases) {
      const phase = worker.phases.get(phaseName);
      if (phase === undefined) throw new Error(`missing Decide phase '${phaseName}'`);
      const definition = readFileSync(
        path.join(PROJECT_ROOT, ".pi", "agents", `${agent}.md`),
        "utf8"
      );
      const tools = definition
        .match(/^tools:\s*(.+)$/mu)?.[1]
        ?.split(",")
        .map((item) => item.trim());
      expect(tools).toBeDefined();
      expect(tools?.length).toBeGreaterThan(0);
      expect(new Set(tools).size).toBe(tools?.length);
      expect(tools).toContain("artifact_read");
      expect(phase.allowed_tools ?? tools).toEqual(tools);
      expect(definition).not.toContain(".pi/skills/decide");
    }
  });
});
