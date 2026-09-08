import { describe, expect, it } from "vitest";

import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../src/playbooks/registry.js";

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
});
