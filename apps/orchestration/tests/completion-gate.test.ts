import { describe, expect, it } from "vitest";

import { CompletionGateSchema, validateContract, type CompletionGate } from "../src/contracts.js";
import { evaluateCompletionGate } from "../src/playbooks/playbook.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

const RESEARCH_GATE = RESEARCH_SKILL_CONTRACT.completion_gate;

function terminalResultGate(overrides: Partial<CompletionGate> = {}): CompletionGate {
  return {
    schema_version: 2,
    allowed_terminal_origins: ["report_writing"],
    required_visited_states: ["researching", "report_writing"],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "test.terminal-result",
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "allow_any" },
    ...overrides,
  };
}

describe("W7 v2 research reference gate", () => {
  it("validates as a closed v2 gate", () => {
    expect(() => validateContract(CompletionGateSchema, RESEARCH_GATE, "gate")).not.toThrow();
    expect(RESEARCH_GATE).toMatchObject({
      schema_version: 2,
      allowed_terminal_origins: ["rendering"],
      required_visited_states: [
        "researching",
        "synthesizing",
        "sealing_core",
        "validating",
        "rendering",
      ],
      required_receipt_predicates: ["research_latest_core_dod.v1"],
      unresolved_policy: { mode: "max_count", max_count: 0 },
    });
  });

  it("rejects v1, missing, extra, empty-origin, and duplicate fields", () => {
    const valid = terminalResultGate();
    const { unresolved_policy: _missing, ...missing } = valid;
    for (const invalid of [
      { schema_version: 1, required_receipts: [], required_states: [] },
      missing,
      { ...valid, extra: true },
      { ...valid, allowed_terminal_origins: [] },
      { ...valid, allowed_terminal_origins: ["report_writing", "report_writing"] },
      { ...valid, required_visited_states: ["researching", "researching"] },
      { ...valid, required_receipt_predicates: ["p.v1", "p.v1"] },
    ]) {
      expect(() => validateContract(CompletionGateSchema, invalid, "gate")).toThrow();
    }
  });

  it("consumes origin, visit history, and allow-any unresolved policy", () => {
    expect(
      evaluateCompletionGate({
        gate: terminalResultGate(),
        terminalStatus: "complete",
        met: true,
        originState: "report_writing",
        visitedStates: ["intake", "researching", "report_writing"],
        unresolvedCount: 128,
      })
    ).toEqual([]);
    expect(
      evaluateCompletionGate({
        gate: terminalResultGate(),
        terminalStatus: "complete",
        met: true,
        originState: "researching",
        visitedStates: ["researching", "report_writing"],
        unresolvedCount: 0,
      })
    ).toContain("TERMINAL_ORIGIN_NOT_ALLOWED");
    expect(
      evaluateCompletionGate({
        gate: terminalResultGate(),
        terminalStatus: "complete",
        met: true,
        originState: "report_writing",
        visitedStates: ["report_writing"],
        unresolvedCount: 0,
      })
    ).toContain("REQUIRED_STATE_NOT_VISITED");
  });

  it("enforces max_count and never gates honest negative terminals", () => {
    const gate = terminalResultGate({ unresolved_policy: { mode: "max_count", max_count: 0 } });
    expect(
      evaluateCompletionGate({
        gate,
        terminalStatus: "complete",
        met: true,
        originState: "report_writing",
        visitedStates: ["researching", "report_writing"],
        unresolvedCount: 1,
      })
    ).toContain("UNRESOLVED_LIMIT_EXCEEDED");
    for (const terminalStatus of ["incomplete", "error", "cancelled"]) {
      expect(
        evaluateCompletionGate({
          gate,
          terminalStatus,
          met: false,
          originState: "arbitrary",
          visitedStates: [],
          unresolvedCount: 128,
        })
      ).toEqual([]);
    }
  });
});
