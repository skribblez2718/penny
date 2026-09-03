import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolvePlaybook,
  skillContractSha256,
  type PlaybookRegistrationV1,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSkillIngress } from "../../candidate-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; registration: PlaybookRegistrationV1 } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-candidate-lifecycle-"));
  roots.push(root);
  const production = resolvePlaybook("research");
  if (production === undefined || production.worker.kind !== "catalog-agent") {
    throw new Error("production fixture registration is unavailable");
  }
  const name = "lifecycle-candidate";
  const registration: PlaybookRegistrationV1 = {
    ...production,
    name,
    contract: { ...production.contract, name, release_status: "candidate" },
    worker: { ...production.worker, workflow_name: name },
  };
  const packageRoot = path.join(root, ".pi", "skills", name);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Lifecycle candidate. Use when integration testing candidate admission. Do not use for direct work.",
      "disable-model-invocation: true",
      "metadata:",
      "  penny:",
      "    engine: orchestration",
      "    release_status: candidate",
      "---",
      "",
    ].join("\n"),
    "utf8"
  );
  return { root, registration };
}

function writeEnablement(root: string, name: string, digest: string): void {
  const file = path.join(root, ".pi", "candidate-enablement.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      schema_version: 1,
      enabled_candidates: [{ name, contract_sha256: digest }],
    })}\n`,
    "utf8"
  );
}

describe("candidate lifecycle integration", () => {
  it("moves only through disabled → exact static binding → stale refusal without model/session work", () => {
    const { root, registration } = fixture();
    const candidateRegistry = new Map([[registration.name, registration]]);
    const disabled = resolveSkillIngress({
      projectRoot: root,
      name: registration.name,
      candidateRegistry,
    });
    expect(disabled).toMatchObject({ ok: false, code: "CANDIDATE_DISABLED" });

    const digest = skillContractSha256(registration.contract);
    writeEnablement(root, registration.name, digest);
    const enabled = resolveSkillIngress({
      projectRoot: root,
      name: registration.name,
      candidateRegistry,
    });
    expect(enabled).toMatchObject({
      ok: true,
      release_status: "candidate",
      contract_sha256: digest,
    });

    writeEnablement(root, registration.name, "0".repeat(64));
    const stale = resolveSkillIngress({
      projectRoot: root,
      name: registration.name,
      candidateRegistry,
    });
    expect(stale).toMatchObject({ ok: false, code: "CANDIDATE_CONTRACT_STALE" });
  });
});
