import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  PLAN_CANDIDATE_REGISTRATION,
  PLAN_EVALUATION_ABLATION_REGISTRY,
  PLAN_LIFECYCLE_STATUS,
  PLAYBOOK_REGISTRY,
  resolveEvaluationCandidate,
  skillContractSha256,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import { resolveSkillIngress } from "../../candidate-config.js";
import {
  checkSkillPackage,
  discoverSkillsFromDirectory,
  modelInvocableSkills,
} from "../../skill-discovery.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);

describe("model-visible source-defined Plan candidate (PREPARED_NOT_MEASURED)", () => {
  it("keeps the provider-free lifecycle harness-only", () => {
    expect(PLAN_LIFECYCLE_STATUS).toBe("PREPARED_NOT_MEASURED");
  });

  it("is model-visible but remains outside production and disabled without host config", () => {
    const skillsDir = path.join(PROJECT_ROOT, ".pi", "skills");
    const disabledProjectRoot = path.join(PROJECT_ROOT, ".candidate-config-disabled-fixture");
    const packages = discoverSkillsFromDirectory(skillsDir);
    const packageCheck = checkSkillPackage({
      skillsDir,
      name: "plan",
      expectedReleaseStatus: "candidate",
      discoveredSkills: packages,
    });
    expect(packageCheck).toMatchObject({ ok: true });
    expect(PLAYBOOK_REGISTRY.has("plan")).toBe(false);
    expect(packages.find((skill) => skill.name === "plan")).toMatchObject({
      releaseStatus: "candidate",
      disableModelInvocation: false,
    });
    expect(modelInvocableSkills(packages).map((skill) => skill.name)).toContain("plan");
    const native = loadSkills({
      cwd: PROJECT_ROOT,
      agentDir: path.join(PROJECT_ROOT, ".native-discovery-test-agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(native.skills.map((skill) => skill.name)).toContain("plan");
    expect(existsSync(path.join(PROJECT_ROOT, ".pi", "skills", "plan"))).toBe(true);
    expect(existsSync(path.join(disabledProjectRoot, ".pi", "candidate-enablement.json"))).toBe(
      false
    );
    expect(
      resolveSkillIngress({ projectRoot: disabledProjectRoot, skillsDir, name: "plan" })
    ).toMatchObject({
      ok: false,
      code: "CANDIDATE_DISABLED",
    });
  });

  it("resolves only through exact evaluation digest and keeps plan-unsealed evaluation-only", () => {
    const digest = skillContractSha256(PLAN_CANDIDATE_REGISTRATION.contract);
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);
    expect(resolveEvaluationCandidate({ name: "plan", contract_sha256: digest })).toBe(
      PLAN_CANDIDATE_REGISTRATION
    );
    expect(
      resolveEvaluationCandidate({ name: "plan", contract_sha256: "0".repeat(64) })
    ).toBeUndefined();
    expect([...PLAN_EVALUATION_ABLATION_REGISTRY.keys()]).toEqual(["plan-unsealed"]);
    const ablation = PLAN_EVALUATION_ABLATION_REGISTRY.get("plan-unsealed");
    if (ablation?.worker.kind !== "catalog-agent") {
      throw new Error("Plan evaluation ablation must use a catalog agent");
    }
    expect([...ablation.worker.phases.values()].map((phase) => phase.allowed_tools)).toEqual([
      ["artifact_read"],
    ]);
    expect(CANDIDATE_PLAYBOOK_REGISTRY.has("plan-unsealed")).toBe(false);
  });

  it("omits allowed_tools from every cognitive phase so exact catalog YAML applies", () => {
    const worker = PLAN_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("Plan must use catalog agents");
    expect([...worker.phases.entries()].map(([phase, binding]) => [phase, binding.agent])).toEqual([
      ["orienting_strategy", "piper"],
      ["gathering_strategy_evidence", "echo"],
      ["strategizing", "piper"],
      ["verifying_strategy", "vera"],
      ["critiquing_strategy", "carren"],
    ]);
    for (const phase of worker.phases.values()) {
      expect(phase).not.toHaveProperty("allowed_tools");
    }
    expect(worker.guidance).toEqual({
      skill_root: ".pi/skills/plan/assets/prompts",
      resolution: "per_agent_phase",
    });
    const definition = readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", "piper.md"), "utf8");
    const tools = definition
      .match(/^tools:\s*(.+)$/mu)?.[1]
      ?.split(",")
      .map((item) => item.trim());
    expect(tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "web_search",
      "web_fetch",
      "artifact_read",
      "memory_search",
      "memory_smart_search",
      "memory_get_drawer",
      "memory_list_drawers",
      "memory_get_taxonomy",
      "memory_check_duplicate",
      "memory_kg_query",
      "memory_kg_timeline",
      "memory_kg_stats",
      "memory_diary_read",
    ]);
    expect(new Set(tools).size).toBe(tools?.length);
    expect(definition).not.toContain(".pi/skills/plan");
    for (const corePath of [
      ["apps", "orchestration", "src", "liveness.ts"],
      ["apps", "orchestration", "src", "model-client.ts"],
      ["apps", "orchestration", "src", "worker.ts"],
    ]) {
      const coreSource = readFileSync(path.join(PROJECT_ROOT, ...corePath), "utf8");
      expect(coreSource).not.toMatch(/plan(?:-unsealed)?[^\n]{0,80}tool/iu);
    }
  });

  it("has admission-only approval metadata but no approval state, directive, gate, or product", () => {
    expect(PLAN_CANDIDATE_REGISTRATION.contract.behavior.approval).toEqual({
      policy: "caller_skill_request",
      additional_approval_required: false,
    });
    expect(
      PLAN_CANDIDATE_REGISTRATION.contract.behavior.approval.additional_approval_required
    ).toBe(false);
    const source = readFileSync(
      path.join(PROJECT_ROOT, "apps", "orchestration", "src", "playbooks", "plan.ts"),
      "utf8"
    );
    const contractSource = readFileSync(
      path.join(PROJECT_ROOT, "apps", "orchestration", "src", "skill-contracts", "plan.ts"),
      "utf8"
    );
    expect(source).toMatch(/penny\.decision\.v2/iu);
    expect(source).not.toMatch(/from\s+["'][^"']*skill-contracts\/decide/iu);
    expect(source).not.toMatch(/Tabitha/iu);
    expect(contractSource).not.toMatch(/skill-contracts\/decide|DecisionV2|Tabitha/iu);
    expect(canonicalProductSource(source, contractSource)).not.toMatch(
      /task_graph|execution_state|approval_state|awaiting_approval|approval_gate|approval_receipt/iu
    );
    expect(source).not.toMatch(/action:\s*["']await_user["']/u);
  });
});

function canonicalProductSource(...values: readonly string[]): string {
  return values.join("\n");
}
