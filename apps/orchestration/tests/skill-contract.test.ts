/** P2 — closed SkillContractV2 and fail-closed registration projections. */

import { requireValue } from "./helpers/narrowing.js";
import { describe, expect, it } from "vitest";

import { SkillContractSchema, validateContract, type SkillContract } from "../src/contracts.js";
import {
  DEFAULT_PLAYBOOK_NAME,
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
} from "../src/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

function clone(): SkillContract {
  return structuredClone(RESEARCH_SKILL_CONTRACT);
}

describe("P2 research reference contract", () => {
  it("validates against the closed V2 schema and is the shipped contract", () => {
    expect(() =>
      validateContract(SkillContractSchema, RESEARCH_SKILL_CONTRACT, "research contract")
    ).not.toThrow();
    const registration = resolvePlaybook(DEFAULT_PLAYBOOK_NAME);
    expect(registration?.contract).toEqual(RESEARCH_SKILL_CONTRACT);
    expect(
      validateRegistrationContract(requireValue(registration, "research registration")).name
    ).toBe("research");
  });

  it("binds typed ports, active legacy output, behavior, and the liveness policy", () => {
    expect(RESEARCH_SKILL_CONTRACT.io.request.schema_id).toBe("penny.research-request.v1");
    expect(RESEARCH_SKILL_CONTRACT.io.input_ports.map((port) => port.name)).toEqual([
      "prior_grounded_synthesis",
      "legacy_context",
    ]);
    expect(RESEARCH_SKILL_CONTRACT.io.active_output_ports.map((port) => port.name)).toEqual([
      "grounded_synthesis",
    ]);
    expect(RESEARCH_SKILL_CONTRACT.behavior.side_effects.allowed_relative_paths).toEqual([
      "report.md",
      "sources.md",
      "README.md",
    ]);
    expect(RESEARCH_SKILL_CONTRACT.budget_policy).toEqual({
      schema_version: 1,
      policy_id: "penny.research-budget-policy.v1",
      resolver_id: "researchLivenessPolicy",
      admission_id: "LivenessController.admitInvocation",
      snapshot_id: "LivenessController.snapshot+phaseAttemptProjection",
    });
  });
});

describe("P2 contract fails closed", () => {
  it("rejects unknown, missing, V1 debt, and dynamic tool-posture fields", () => {
    expect(() =>
      validateContract(SkillContractSchema, { ...clone(), rogue_field: true }, "contract")
    ).toThrow();
    const { completion_gate: _removed, ...missing } = clone();
    expect(() => validateContract(SkillContractSchema, missing, "contract")).toThrow();
    for (const debt of [
      { accepts: ["agent-output"] },
      { produces: ["agent-output"] },
      { invariants: ["descriptive only"] },
      { budgets: { max_sub_queries: 4 } },
      { tool_posture: {} },
    ]) {
      expect(() =>
        validateContract(SkillContractSchema, { ...clone(), ...debt }, "contract")
      ).toThrow();
    }
  });

  it("rejects unknown guidance and registration projection drift", () => {
    expect(() =>
      validateContract(
        SkillContractSchema,
        { ...clone(), guidance: { ...clone().guidance, resolution: "per_run" } },
        "contract"
      )
    ).toThrow();
    const shipped = requireValue(resolvePlaybook(DEFAULT_PLAYBOOK_NAME), "research registration");
    expect(() =>
      validateRegistrationContract({
        ...shipped,
        contract: {
          ...clone(),
          behavior: {
            ...clone().behavior,
            approval: {
              ...clone().behavior.approval,
              additional_approval_required: true,
            },
          },
        },
      })
    ).toThrow(/projection drifted/);
  });

  it("rejects a contract whose name disagrees with its registration", () => {
    const shipped = requireValue(resolvePlaybook(DEFAULT_PLAYBOOK_NAME), "research registration");
    const mismatched: PlaybookRegistrationV1 = {
      name: "research",
      contract: { ...clone(), name: "knowledge-base" },
      ingress: shipped.ingress,
      ...(shipped.start_admission === undefined
        ? {}
        : { start_admission: shipped.start_admission }),
      liveness: shipped.liveness,
      worker: shipped.worker,
      completionReceiptPredicates: new Map(),
      construct: () => {
        throw new Error("not constructed in this test");
      },
    };
    expect(() => validateRegistrationContract(mismatched)).toThrow(/does not match registration/);
  });

  it("ships only research and knowledge-base", () => {
    expect(PLAYBOOK_REGISTRY.size).toBe(2);
  });
});
