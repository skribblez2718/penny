import { describe, expect, it } from "vitest";

import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";

describe("single executable registry", () => {
  it("contains every authorized universal playbook", () => {
    expect([...PLAYBOOK_REGISTRY.keys()]).toEqual([
      "assess",
      "decide",
      "define",
      "diagnose",
      "imagegen",
      "knowledge-base",
      "plan",
      "produce",
      "research",
      "sca",
      "videogen",
    ]);
    for (const registration of PLAYBOOK_REGISTRY.values()) {
      expect(validateRegistrationContract(registration)).toBe(registration.contract);
    }
  });
});
