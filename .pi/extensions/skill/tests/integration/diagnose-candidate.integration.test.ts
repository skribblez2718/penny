import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  DIAGNOSE_CANDIDATE_REGISTRATION,
  PLAYBOOK_REGISTRY,
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

describe("model-visible diagnose candidate", () => {
  it("is visible to Pi and Penny while remaining outside production", () => {
    const skillsDir = path.join(PROJECT_ROOT, ".pi", "skills");
    const discovered = discoverSkillsFromDirectory(skillsDir);
    expect(
      checkSkillPackage({
        skillsDir,
        name: "diagnose",
        expectedReleaseStatus: "candidate",
        discoveredSkills: discovered,
      })
    ).toMatchObject({ ok: true });
    expect(PLAYBOOK_REGISTRY.has("diagnose")).toBe(false);
    expect(CANDIDATE_PLAYBOOK_REGISTRY.get("diagnose")).toBe(DIAGNOSE_CANDIDATE_REGISTRATION);
    expect(discovered.find((skill) => skill.name === "diagnose")).toMatchObject({
      releaseStatus: "candidate",
      disableModelInvocation: false,
    });
    expect(modelInvocableSkills(discovered).map((skill) => skill.name)).toContain("diagnose");
    const native = loadSkills({
      cwd: PROJECT_ROOT,
      agentDir: path.join(PROJECT_ROOT, ".native-discovery-test-agent"),
      skillPaths: [],
      includeDefaults: true,
    });
    expect(native.skills.map((skill) => skill.name)).toContain("diagnose");
  });

  it("admits explicit skill ingress only through the ignored exact-contract-digest binding", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-diagnose-enablement-"));
    temporaryRoots.push(projectRoot);
    const skillsDir = path.join(PROJECT_ROOT, ".pi", "skills");
    expect(resolveSkillIngress({ projectRoot, skillsDir, name: "diagnose" })).toMatchObject({
      ok: false,
      code: "CANDIDATE_DISABLED",
    });

    const digest = skillContractSha256(DIAGNOSE_CANDIDATE_REGISTRATION.contract);
    mkdirSync(path.join(projectRoot, ".pi"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, ".pi", "candidate-enablement.json"),
      `${JSON.stringify({
        schema_version: 1,
        enabled_candidates: [{ name: "diagnose", contract_sha256: digest }],
      })}\n`,
      "utf8"
    );
    expect(resolveSkillIngress({ projectRoot, skillsDir, name: "diagnose" })).toMatchObject({
      ok: true,
      release_status: "candidate",
      contract_sha256: digest,
    });

    writeFileSync(
      path.join(projectRoot, ".pi", "candidate-enablement.json"),
      `${JSON.stringify({
        schema_version: 1,
        enabled_candidates: [{ name: "diagnose", contract_sha256: "0".repeat(64) }],
      })}\n`,
      "utf8"
    );
    expect(resolveSkillIngress({ projectRoot, skillsDir, name: "diagnose" })).toMatchObject({
      ok: false,
      code: "CANDIDATE_CONTRACT_STALE",
    });
  });

  it("binds four phases with omitted allowed_tools so exact YAML applies, and no Carren", () => {
    const worker = DIAGNOSE_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("diagnose must use catalog agents");
    expect([...worker.phases.entries()].map(([state, phase]) => [state, phase.agent])).toEqual([
      ["decomposing_causes", "annie"],
      ["generating_hypotheses", "ida"],
      ["adjudicating_diagnosis", "demetri"],
      ["verifying_diagnosis", "vera"],
    ]);
    for (const phase of worker.phases.values()) {
      expect(phase).not.toHaveProperty("allowed_tools");
    }
    expect([...worker.phases.values()].map((phase) => phase.agent)).not.toContain("carren");
    expect(worker.guidance).toEqual({
      skill_root: ".pi/skills/diagnose/assets/prompts",
      resolution: "per_agent_phase",
    });
  });
});
