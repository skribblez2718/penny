/**
 * W3 — SkillContractV1 (Foundation stage, workstream 1 of 3).
 *
 * The contract is authority metadata, so an invalid one must fail closed rather than
 * degrade. These tests also pin the two Foundation-stage boundary decisions:
 *   - budgets are DECLARATIVE ONLY (W4 deferred, `research-mode-presets` loan stays open)
 *   - guidance carries a per-agent-phase option, required by the KB prompt shape
 */

import { describe, expect, it } from "vitest";

import { SkillContractSchema, validateContract, type SkillContract } from "../src/contracts.js";
import {
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  SOLE_PRODUCTION_PLAYBOOK,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
} from "../src/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";
import { COMPATIBILITY_LOANS } from "../src/loans.js";

function clone(): SkillContract {
  return JSON.parse(JSON.stringify(RESEARCH_SKILL_CONTRACT)) as SkillContract;
}

describe("W3 research reference contract", () => {
  it("validates against the closed schema", () => {
    expect(() =>
      validateContract(SkillContractSchema, RESEARCH_SKILL_CONTRACT, "research contract")
    ).not.toThrow();
  });

  it("is the contract the registry ships for research", () => {
    const registration = resolvePlaybook(SOLE_PRODUCTION_PLAYBOOK);
    expect(registration?.contract).toEqual(RESEARCH_SKILL_CONTRACT);
    expect(validateRegistrationContract(registration as PlaybookRegistrationV1).name).toBe(
      "research"
    );
  });

  it("declares research's real guidance root and per-agent resolution", () => {
    // Must match the path the worker actually uses today; W6 parameterizes the lookup
    // without changing where research's prompts live.
    expect(RESEARCH_SKILL_CONTRACT.guidance.skill_root).toBe(".pi/skills/research/assets/prompts");
    expect(RESEARCH_SKILL_CONTRACT.guidance.resolution).toBe("per_agent");
  });

  it("declares budgets matching the pinned budget-constraint surface", () => {
    expect(Object.keys(RESEARCH_SKILL_CONTRACT.budgets).sort()).toEqual([
      "critique_passes",
      "max_fan_width",
      "max_research_rounds",
      "max_sub_queries",
    ]);
  });
});

describe("W3 fails closed", () => {
  it("rejects an unknown key", () => {
    const bad = { ...clone(), rogue_field: true };
    expect(() => validateContract(SkillContractSchema, bad, "contract")).toThrow();
  });

  it("rejects a missing required field", () => {
    const bad = clone() as Partial<SkillContract>;
    delete bad.completion_gate;
    expect(() => validateContract(SkillContractSchema, bad, "contract")).toThrow();
  });

  it("rejects an unknown feedback kind", () => {
    const bad = { ...clone(), feedback_kinds: ["nonsense_gap"] };
    expect(() => validateContract(SkillContractSchema, bad, "contract")).toThrow();
  });

  it("rejects an unknown guidance resolution", () => {
    const bad = clone();
    (bad.guidance as { resolution: string }).resolution = "per_run";
    expect(() => validateContract(SkillContractSchema, bad, "contract")).toThrow();
  });

  it("rejects an empty trust-profile list", () => {
    const bad = clone();
    (bad.authority as { trust_profiles: string[] }).trust_profiles = [];
    expect(() => validateContract(SkillContractSchema, bad, "contract")).toThrow();
  });

  it("rejects a contract whose name disagrees with its registration", () => {
    const mismatched: PlaybookRegistrationV1 = {
      name: "research",
      contract: { ...clone(), name: "knowledge-base" },
      construct: () => {
        throw new Error("not constructed in this test");
      },
    };
    expect(() => validateRegistrationContract(mismatched)).toThrow(/does not match registration/);
  });
});

describe("W3 Foundation-stage boundaries", () => {
  it("keeps budgets declarative: W4 is deferred and its loan stays open", () => {
    // If W4 were pulled into this stage, this loan would be closed and the assertion
    // would fail -- which is the intended tripwire, not an inconvenience.
    const loan = COMPATIBILITY_LOANS.find((entry) => entry.id === "research-mode-presets");
    expect(loan, "research-mode-presets loan must still exist while W4 is deferred").toBeDefined();
  });

  it("supports the per-agent-phase resolution the KB prompt shape needs", () => {
    const kbShaped = { ...clone(), name: "research" };
    (kbShaped.guidance as { resolution: string }).resolution = "per_agent_phase";
    expect(() => validateContract(SkillContractSchema, kbShaped, "contract")).not.toThrow();
  });

  it("ships research and knowledge-base (two registrations)", () => {
    expect(PLAYBOOK_REGISTRY.size).toBe(2);
  });
});
