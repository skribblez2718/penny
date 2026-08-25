import { parseJson, requireRecord, requireString, requireStringArray } from "./narrowing.js";

export interface ResearchParityPin {
  readonly states: string[];
  readonly agent_by_state: Record<string, string>;
  readonly modes: { readonly allowed: string[]; readonly default: string };
  readonly budget_constraints: string[];
  readonly output_files: string[];
  readonly terminal: {
    readonly completion_state: string;
    readonly completion_field: string;
    readonly met_field: string;
  };
  readonly non_states: string[];
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, requireString(entry, `${label}.${key}`)])
  );
}

export function parseResearchParityPin(text: string): ResearchParityPin {
  const value = requireRecord(parseJson(text), "research parity pin");
  const modes = requireRecord(value["modes"], "research parity pin.modes");
  const terminal = requireRecord(value["terminal"], "research parity pin.terminal");
  return {
    states: requireStringArray(value["states"], "research parity pin.states"),
    agent_by_state: requireStringRecord(
      value["agent_by_state"],
      "research parity pin.agent_by_state"
    ),
    modes: {
      allowed: requireStringArray(modes["allowed"], "research parity pin.modes.allowed"),
      default: requireString(modes["default"], "research parity pin.modes.default"),
    },
    budget_constraints: requireStringArray(
      value["budget_constraints"],
      "research parity pin.budget_constraints"
    ),
    output_files: requireStringArray(value["output_files"], "research parity pin.output_files"),
    terminal: {
      completion_state: requireString(
        terminal["completion_state"],
        "research parity pin.terminal.completion_state"
      ),
      completion_field: requireString(
        terminal["completion_field"],
        "research parity pin.terminal.completion_field"
      ),
      met_field: requireString(terminal["met_field"], "research parity pin.terminal.met_field"),
    },
    non_states: requireStringArray(value["non_states"], "research parity pin.non_states"),
  };
}
