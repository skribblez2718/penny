import { describe, expect, it } from "vitest";

import {
  PLAYBOOK_REGISTRY,
  resolveEvaluationCandidate,
  skillContractSha256,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "../src/playbooks/registry.js";
import { CORE_ONLY_REGISTRATION } from "./fixtures/core-only-playbook.js";

function evaluationRegistration(): PlaybookRegistrationV1 {
  const name = "fixture-evaluation-variant";
  const worker = CORE_ONLY_REGISTRATION.worker;
  if (worker.kind !== "catalog-agent") {
    throw new Error("core-only fixture must use a catalog worker");
  }
  return {
    ...CORE_ONLY_REGISTRATION,
    name,
    contract: { ...CORE_ONLY_REGISTRATION.contract, name },
    worker: { ...worker, workflow_name: name },
  };
}

describe("single executable registry", () => {
  it("contains every authorized universal playbook", () => {
    expect([...PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "diagnose",
      "knowledge-base",
      "plan",
      "produce",
      "research",
    ]);
    for (const registration of PLAYBOOK_REGISTRY.values()) {
      expect(validateRegistrationContract(registration)).toBe(registration.contract);
    }
  });

  it("resolves an evaluation variant only by its exact canonical contract digest", () => {
    const registration = evaluationRegistration();
    const registry: PlaybookRegistryV1 = new Map([[registration.name, registration]]);
    const digest = skillContractSha256(registration.contract);
    expect(
      resolveEvaluationCandidate({
        name: registration.name,
        contract_sha256: digest,
        registry,
      })
    ).toBe(registration);
    expect(
      resolveEvaluationCandidate({
        name: registration.name,
        contract_sha256: "0".repeat(64),
        registry,
      })
    ).toBeUndefined();
  });
});
