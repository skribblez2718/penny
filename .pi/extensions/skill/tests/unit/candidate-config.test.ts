import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolvePlaybook,
  skillContractSha256,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import {
  CANDIDATE_ENABLEMENT_RELATIVE_PATH,
  readCandidateEnablement,
  resolveSkillIngress,
} from "../../candidate-config.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-candidate-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidate(): PlaybookRegistrationV1 {
  const production = resolvePlaybook("research");
  if (production === undefined || production.worker.kind !== "catalog-agent") {
    throw new Error("research registration fixture is unavailable");
  }
  const name = "fixture-candidate";
  return {
    ...production,
    name,
    contract: { ...production.contract, name, release_status: "candidate" },
    worker: { ...production.worker, workflow_name: name },
  };
}

function registry(registration: PlaybookRegistrationV1): PlaybookRegistryV1 {
  return new Map([[registration.name, registration]]);
}

function writeSkillPackage(
  root: string,
  name: string,
  release: "production" | "candidate" = "candidate"
): void {
  const directory = path.join(root, ".pi", "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Fixture candidate. Use when testing candidate ingress. Do not use for direct work.",
      `disable-model-invocation: ${release === "candidate" ? "true" : "false"}`,
      "metadata:",
      "  penny:",
      "    engine: orchestration",
      `    release_status: ${release}`,
      "---",
      "",
    ].join("\n"),
    "utf8"
  );
}

function writeConfig(root: string, value: unknown): void {
  const file = path.join(root, CANDIDATE_ENABLEMENT_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

describe("static candidate enablement", () => {
  it("treats a missing file as disabled and never creates it", () => {
    const root = projectRoot();
    const registration = candidate();
    expect(readCandidateEnablement(root)).toEqual({ status: "missing" });
    expect(
      resolveSkillIngress({
        projectRoot: root,
        name: registration.name,
        candidateRegistry: registry(registration),
      })
    ).toMatchObject({ ok: false, code: "CANDIDATE_DISABLED" });
    expect(readCandidateEnablement(root)).toEqual({ status: "missing" });
  });

  it("admits only one exact name/digest binding with a matching candidate package", () => {
    const root = projectRoot();
    const registration = candidate();
    const digest = skillContractSha256(registration.contract);
    writeSkillPackage(root, registration.name);
    writeConfig(root, {
      schema_version: 1,
      enabled_candidates: [{ name: registration.name, contract_sha256: digest }],
    });
    expect(
      resolveSkillIngress({
        projectRoot: root,
        name: registration.name,
        candidateRegistry: registry(registration),
      })
    ).toMatchObject({
      ok: true,
      release_status: "candidate",
      contract_sha256: digest,
    });
  });

  it("returns typed refusals for malformed, stale, and package-mismatch cases", () => {
    const registration = candidate();
    const candidateRegistry = registry(registration);

    const malformedRoot = projectRoot();
    writeConfig(malformedRoot, { schema_version: 1, enabled_candidates: "wrong" });
    expect(
      resolveSkillIngress({
        projectRoot: malformedRoot,
        name: registration.name,
        candidateRegistry,
      })
    ).toMatchObject({ ok: false, code: "CANDIDATE_CONFIG_INVALID" });

    const staleRoot = projectRoot();
    writeSkillPackage(staleRoot, registration.name);
    writeConfig(staleRoot, {
      schema_version: 1,
      enabled_candidates: [{ name: registration.name, contract_sha256: "0".repeat(64) }],
    });
    expect(
      resolveSkillIngress({
        projectRoot: staleRoot,
        name: registration.name,
        candidateRegistry,
      })
    ).toMatchObject({ ok: false, code: "CANDIDATE_CONTRACT_STALE" });

    const packageRoot = projectRoot();
    writeSkillPackage(packageRoot, registration.name, "production");
    writeConfig(packageRoot, {
      schema_version: 1,
      enabled_candidates: [
        {
          name: registration.name,
          contract_sha256: skillContractSha256(registration.contract),
        },
      ],
    });
    expect(
      resolveSkillIngress({
        projectRoot: packageRoot,
        name: registration.name,
        candidateRegistry,
      })
    ).toMatchObject({ ok: false, code: "CANDIDATE_PACKAGE_INVALID" });
  });

  it("rejects unsafe enablement files without following them", () => {
    const root = projectRoot();
    const target = path.join(root, "enablement-target.json");
    writeFileSync(target, '{"schema_version":1,"enabled_candidates":[]}\n', "utf8");
    const file = path.join(root, CANDIDATE_ENABLEMENT_RELATIVE_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    symlinkSync(target, file);
    expect(readCandidateEnablement(root)).toMatchObject({ status: "invalid" });
  });

  it("fails closed on production package and registry namespace mismatch", () => {
    const root = projectRoot();
    writeSkillPackage(root, "research", "candidate");
    expect(resolveSkillIngress({ projectRoot: root, name: "research" })).toMatchObject({
      ok: false,
      code: "SKILL_ENTRYPOINT_MISMATCH",
    });
  });

  it("fails closed when a name overlaps production and candidate registries", () => {
    const root = projectRoot();
    writeSkillPackage(root, "research", "production");
    const fixture = candidate();
    if (fixture.worker.kind !== "catalog-agent") {
      throw new Error("candidate fixture worker is unavailable");
    }
    const overlapping: PlaybookRegistrationV1 = {
      ...fixture,
      name: "research",
      contract: { ...fixture.contract, name: "research" },
      worker: { ...fixture.worker, workflow_name: "research" },
    };
    expect(
      resolveSkillIngress({
        projectRoot: root,
        name: "research",
        candidateRegistry: registry(overlapping),
      })
    ).toMatchObject({ ok: false, code: "SKILL_ENTRYPOINT_MISMATCH" });
  });

  it("keeps exact production research available when candidate config is malformed", () => {
    const root = projectRoot();
    writeSkillPackage(root, "research", "production");
    writeConfig(root, { malformed: true });
    expect(resolveSkillIngress({ projectRoot: root, name: "research" })).toMatchObject({
      ok: true,
      release_status: "production",
    });
  });
});
