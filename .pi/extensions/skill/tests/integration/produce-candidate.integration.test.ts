import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  PLAYBOOK_REGISTRY,
  PRODUCE_CANDIDATE_REGISTRATION,
  skillContractSha256,
} from "@penny/orchestration/source";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

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
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model-visible produce candidate", () => {
  it("is visible to Pi and Penny while remaining outside production", () => {
    const skillsDir = path.join(PROJECT_ROOT, ".pi", "skills");
    const discovered = discoverSkillsFromDirectory(skillsDir);
    expect(
      checkSkillPackage({
        skillsDir,
        name: "produce",
        expectedReleaseStatus: "candidate",
        discoveredSkills: discovered,
      })
    ).toMatchObject({ ok: true });
    expect(PLAYBOOK_REGISTRY.has("produce")).toBe(false);
    expect(CANDIDATE_PLAYBOOK_REGISTRY.get("produce")).toBe(PRODUCE_CANDIDATE_REGISTRATION);
    expect(discovered.find((skill) => skill.name === "produce")).toMatchObject({
      releaseStatus: "candidate",
      disableModelInvocation: false,
    });
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toContain("produce");
    const native = loadSkills({
      cwd: PROJECT_ROOT,
      agentDir: path.join(PROJECT_ROOT, ".native-discovery-test-agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(native.skills.map((skill) => skill.name)).toContain("produce");
  });

  it("admits explicit skill ingress only through ignored exact-contract-digest enablement", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-produce-enablement-"));
    temporaryRoots.push(projectRoot);
    const skillsDir = path.join(PROJECT_ROOT, ".pi", "skills");
    expect(resolveSkillIngress({ projectRoot, skillsDir, name: "produce" })).toMatchObject({
      ok: false,
      code: "CANDIDATE_DISABLED",
    });

    const digest = skillContractSha256(PRODUCE_CANDIDATE_REGISTRATION.contract);
    mkdirSync(path.join(projectRoot, ".pi"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, ".pi", "candidate-enablement.json"),
      `${JSON.stringify({
        schema_version: 1,
        enabled_candidates: [{ name: "produce", contract_sha256: digest }],
      })}\n`,
      "utf8"
    );
    expect(resolveSkillIngress({ projectRoot, skillsDir, name: "produce" })).toMatchObject({
      ok: true,
      release_status: "candidate",
      contract_sha256: digest,
    });

    writeFileSync(
      path.join(projectRoot, ".pi", "candidate-enablement.json"),
      `${JSON.stringify({
        schema_version: 1,
        enabled_candidates: [{ name: "produce", contract_sha256: "0".repeat(64) }],
      })}\n`,
      "utf8"
    );
    expect(resolveSkillIngress({ projectRoot, skillsDir, name: "produce" })).toMatchObject({
      ok: false,
      code: "CANDIDATE_CONTRACT_STALE",
    });
  });

  it("binds Ida, Skribble, Carren, and Vera with omitted allowed_tools so exact YAML applies", () => {
    const worker = PRODUCE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("produce must use catalog agents");
    expect([...worker.phases.entries()].map(([state, phase]) => [state, phase.agent])).toEqual([
      ["exploring_artifact_approaches", "ida"],
      ["materializing_artifact", "skribble"],
      ["critiquing_artifact", "carren"],
      ["verifying_artifact", "vera"],
    ]);
    for (const phase of worker.phases.values()) {
      expect(phase).not.toHaveProperty("allowed_tools");
    }
    expect(worker.guidance).toEqual({
      skill_root: ".pi/skills/produce/assets/prompts",
      resolution: "per_agent_phase",
    });
  });
});
