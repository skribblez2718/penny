import { describe, expect, it } from "vitest";

import { parseResearchParityPin } from "./helpers/fixtures.js";

const VALID_PIN = {
  states: ["planning"],
  agent_by_state: { planning: "piper" },
  modes: { allowed: ["quick"], default: "quick" },
  budget_constraints: ["max_steps"],
  output_files: ["Report.md"],
  terminal: {
    completion_state: "reporting",
    completion_field: "action",
    met_field: "met",
  },
  non_states: ["missing"],
};

describe("fixture extraction helpers", () => {
  it("parses the complete research parity pin", () => {
    expect(parseResearchParityPin(JSON.stringify(VALID_PIN))).toEqual(VALID_PIN);
  });

  it.each([
    ["agent map", { ...VALID_PIN, agent_by_state: undefined }],
    ["mode default", { ...VALID_PIN, modes: { allowed: ["quick"] } }],
    ["terminal field", { ...VALID_PIN, terminal: { ...VALID_PIN.terminal, met_field: undefined } }],
  ])("fails fast when the %s is missing", (_case, malformed) => {
    expect(() => parseResearchParityPin(JSON.stringify(malformed))).toThrow();
  });
});
