import { describe, expect, it } from "vitest";

import {
  ConfidenceSchema,
  ContractValidationError,
  DirectiveSchema,
  RunIdentitySchema,
  SkillContractSchema,
  StartRequestSchema,
  validateContract,
} from "../dist/contracts.js";

import { RESEARCH_SKILL_CONTRACT } from "../dist/playbooks/research.js";

const identity = {
  schema_version: 2,
  run_id: "run-001",
  session_id: "session-001",
  playbook: "research",
  engine_owner: "typescript",
} as const;

describe("orchestration boundary contracts", () => {
  it("represents 128 exact proof ports without changing operation grants", () => {
    const port = RESEARCH_SKILL_CONTRACT.io.input_ports[0];
    if (port === undefined) throw new Error("registered input port absent");
    const contract = {
      ...RESEARCH_SKILL_CONTRACT,
      io: {
        ...RESEARCH_SKILL_CONTRACT.io,
        input_ports: Array.from({ length: 128 }, (_, index) => ({
          ...port,
          name: "exact-proof-" + String(index),
        })),
      },
    };
    expect(
      validateContract(SkillContractSchema, contract, "closed proof capacity").io.input_ports
    ).toHaveLength(128);
    expect(() =>
      validateContract(
        SkillContractSchema,
        {
          ...contract,
          io: {
            ...contract.io,
            input_ports: [...contract.io.input_ports, { ...port, name: "overflow" }],
          },
        },
        "proof overflow"
      )
    ).toThrow(ContractValidationError);
    expect(() =>
      validateContract(SkillContractSchema, { ...contract, approved: true }, "not a grant")
    ).toThrow(ContractValidationError);
  });
  it("accepts an immutable versioned TypeScript identity", () => {
    expect(validateContract(RunIdentitySchema, identity, "identity")).toEqual(identity);
  });

  it("rejects unknown fields at an external boundary", () => {
    expect(() =>
      validateContract(
        StartRequestSchema,
        {
          schema_version: 2,
          action: "start",
          identity,
          goal: "research the subject",
          constraints: {},
          project_root: "/tmp/project",
          trust_profile: "trusted-interactive",
          unexpected: true,
        },
        "start"
      )
    ).toThrow(ContractValidationError);
  });

  it.each(["CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"])(
    "accepts declared confidence %s",
    (confidence) => {
      expect(validateContract(ConfidenceSchema, confidence, "confidence")).toBe(confidence);
    }
  );

  it("rejects undeclared confidence values", () => {
    expect(() => validateContract(ConfidenceSchema, "HIGH", "confidence")).toThrow(
      ContractValidationError
    );
  });

  it("rejects a terminal complete directive when required truth fields are absent", () => {
    expect(() =>
      validateContract(
        DirectiveSchema,
        {
          schema_version: 2,
          action: "complete",
          identity,
          status: "complete",
          result: {},
          artifacts: [],
          unresolved: [],
        },
        "directive"
      )
    ).toThrow(ContractValidationError);
  });
});
