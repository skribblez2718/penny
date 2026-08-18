/**
 * W7 — completion-gate seam (Foundation stage, workstream 1 of 3).
 *
 * The engine, not the playbook, admits a `met: true` terminal. Research's real completion
 * condition -- "must have reached report writing" -- becomes its declared gate, and its
 * terminal outcomes are unchanged (proven by the 28 parity tests staying green).
 *
 * A boundary decision is pinned here: `unresolved_allowance` is ABSENT for research.
 * Research converts an exhausted critique budget into a warning rather than a blocker, so
 * a met run can legitimately carry unresolved items. Forcing an allowance of 0 would have
 * changed behaviour, which this stage forbids.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CompletionGateSchema, validateContract, type CompletionGate } from "../src/contracts.js";
import { evaluateCompletionGate } from "../src/playbooks/playbook.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

const RESEARCH_GATE = RESEARCH_SKILL_CONTRACT.completion_gate;

describe("W7 research reference gate", () => {
  it("validates against the closed schema", () => {
    expect(() => validateContract(CompletionGateSchema, RESEARCH_GATE, "gate")).not.toThrow();
  });

  it("requires terminating from report_writing", () => {
    expect(RESEARCH_GATE.required_states).toEqual(["report_writing"]);
  });

  it("leaves unresolved_allowance absent, so warnings never block a met run", () => {
    expect(RESEARCH_GATE.unresolved_allowance).toBeUndefined();
  });

  it("admits research's real met terminal", () => {
    expect(
      evaluateCompletionGate({
        gate: RESEARCH_GATE,
        terminalStatus: "complete",
        met: true,
        fromState: "report_writing",
        // Exhausted plan/report critique can leave unresolved items on a met run.
        unresolvedCount: 3,
      })
    ).toBeNull();
  });
});

describe("W7 gate enforcement", () => {
  it("refuses a met terminal from a state the gate does not permit", () => {
    const refusal = evaluateCompletionGate({
      gate: RESEARCH_GATE,
      terminalStatus: "complete",
      met: true,
      fromState: "researching",
      unresolvedCount: 0,
    });
    expect(refusal).toMatch(/requires terminating from/);
  });

  it("never gates a non-met terminal, so honest failure stays reachable", () => {
    for (const status of ["incomplete", "cancelled"]) {
      expect(
        evaluateCompletionGate({
          gate: RESEARCH_GATE,
          terminalStatus: status,
          met: false,
          fromState: "researching",
          unresolvedCount: 99,
        }),
        `${status} must pass through`
      ).toBeNull();
    }
  });

  it("enforces unresolved_allowance when a stricter skill declares one", () => {
    const strict: CompletionGate = {
      schema_version: 1,
      required_receipts: [],
      required_states: ["report_writing"],
      unresolved_allowance: 0,
    };
    expect(
      evaluateCompletionGate({
        gate: strict,
        terminalStatus: "complete",
        met: true,
        fromState: "report_writing",
        unresolvedCount: 1,
      })
    ).toMatch(/allows at most 0 unresolved/);
    expect(
      evaluateCompletionGate({
        gate: strict,
        terminalStatus: "complete",
        met: true,
        fromState: "report_writing",
        unresolvedCount: 0,
      })
    ).toBeNull();
  });

  it("admits any originating state when required_states is empty", () => {
    const open: CompletionGate = {
      schema_version: 1,
      required_receipts: [],
      required_states: [],
    };
    expect(
      evaluateCompletionGate({
        gate: open,
        terminalStatus: "complete",
        met: true,
        fromState: "anything",
        unresolvedCount: 0,
      })
    ).toBeNull();
  });
});

describe("W7 engine wiring", () => {
  const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

  it("evaluates the gate before accepting a terminal", () => {
    expect(source).toContain("this.admitTerminal(context, next)");
    expect(source).toContain("evaluateCompletionGate({");
  });

  it("uses the active contract's gate, not a hardcoded rule", () => {
    expect(source).toContain("gate: this.contract.completion_gate");
  });
});
