import { describe, expect, it } from "vitest";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  PLAYBOOK_REGISTRY,
  resolveEvaluationCandidate,
  skillContractSha256,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "../src/playbooks/registry.js";
import { CORE_ONLY_REGISTRATION } from "./fixtures/core-only-playbook.js";

function candidateRegistration(): PlaybookRegistrationV1 {
  const name = "fixture-candidate";
  const worker = CORE_ONLY_REGISTRATION.worker;
  if (worker.kind !== "catalog-agent") {
    throw new Error("core-only fixture must use a catalog worker");
  }
  return {
    ...CORE_ONLY_REGISTRATION,
    name,
    contract: {
      ...CORE_ONLY_REGISTRATION.contract,
      name,
      release_status: "candidate",
    },
    worker: {
      ...worker,
      workflow_name: name,
    },
  };
}

describe("separate production, candidate, and evaluation registry paths", () => {
  it("keeps the exactly sorted source candidates out of production resolution", () => {
    expect([...CANDIDATE_PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "plan",
      "produce",
    ]);
    expect(PLAYBOOK_REGISTRY.has("assess")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("decide")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("diagnose")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("plan")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("produce")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("fixture-candidate")).toBe(false);
  });

  it("resolves source decide only by its exact canonical contract digest", () => {
    const decide = CANDIDATE_PLAYBOOK_REGISTRY.get("decide");
    if (decide === undefined) throw new Error("decide candidate registration is absent");
    expect(
      resolveEvaluationCandidate({
        name: "decide",
        contract_sha256: skillContractSha256(decide.contract),
      })
    ).toBe(decide);
    expect(
      resolveEvaluationCandidate({
        name: "decide",
        contract_sha256: "0".repeat(64),
      })
    ).toBeUndefined();
  });

  it("evaluation resolves one candidate by exact canonical contract digest only", () => {
    const candidate = candidateRegistration();
    const registry: PlaybookRegistryV1 = new Map([[candidate.name, candidate]]);
    const digest = skillContractSha256(candidate.contract);
    expect(
      resolveEvaluationCandidate({
        name: candidate.name,
        contract_sha256: digest,
        registry,
      })
    ).toBe(candidate);
    expect(
      resolveEvaluationCandidate({
        name: candidate.name,
        contract_sha256: "0".repeat(64),
        registry,
      })
    ).toBeUndefined();
  });

  it("rejects release-status and registry-namespace mismatches", () => {
    const candidate = candidateRegistration();
    expect(() => validateRegistrationContract(candidate, "production")).toThrow(/release status/u);
    const production = {
      ...candidate,
      contract: { ...candidate.contract, release_status: "production" as const },
    };
    const registry: PlaybookRegistryV1 = new Map([[production.name, production]]);
    expect(
      resolveEvaluationCandidate({
        name: production.name,
        contract_sha256: skillContractSha256(production.contract),
        registry,
      })
    ).toBeUndefined();
  });
});
