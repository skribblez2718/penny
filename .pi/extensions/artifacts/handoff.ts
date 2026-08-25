import {
  DEFAULT_TOOL_RESULT_BUDGET,
  createTextToolResult,
  enforceToolResultBudget,
  type ToolResultBudget,
} from "../lib/tool-result-budget.js";
import {
  ArtifactClientError,
  canonicalArtifactJson,
  parseArtifactRef,
  type ArtifactRef,
} from "./owner-client.js";

export const INPUT_ARTIFACTS_SCHEMA_VERSION = 2 as const;

const INPUT_ARTIFACT_FIELDS = ["schema_version", "artifacts"] as const;
const INPUT_ARTIFACT_BINDING_FIELDS = ["slot", "ref"] as const;

export interface InputArtifactBinding {
  slot: string;
  ref: ArtifactRef;
}

export interface InputArtifactsV2 {
  schema_version: 2;
  artifacts: InputArtifactBinding[];
}

function contractError(message: string): never {
  throw new ArtifactClientError("ARTIFACT_CONTRACT_INVALID", message);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    contractError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(record);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const unknown = keys.filter((key) => !expected.includes(key));
  if (missing.length)
    contractError(`${label} missing required fields: ${missing.sort().join(", ")}`);
  if (unknown.length) contractError(`${label} has unknown fields: ${unknown.sort().join(", ")}`);
}

function canonicalString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    contractError(`${field} must be a non-empty canonical string`);
  }
  return value;
}

/** Parse canonical schema-v2 exact communication refs. */
export function parseInputArtifacts(value: unknown): InputArtifactsV2 {
  const record = asObject(value, "input_artifacts");
  exactKeys(record, INPUT_ARTIFACT_FIELDS, "input_artifacts");
  if (record.schema_version !== INPUT_ARTIFACTS_SCHEMA_VERSION) {
    contractError("unsupported input_artifacts schema version");
  }
  if (!Array.isArray(record.artifacts)) {
    contractError("input_artifacts.artifacts must be an array");
  }
  const artifacts = record.artifacts.map((value, index): InputArtifactBinding => {
    const label = `input_artifacts.artifacts[${index}]`;
    const binding = asObject(value, label);
    exactKeys(binding, INPUT_ARTIFACT_BINDING_FIELDS, label);
    return {
      slot: canonicalString(binding.slot, `${label}.slot`),
      ref: parseArtifactRef(binding.ref),
    };
  });
  const slots = artifacts.map((binding) => binding.slot);
  const ids = artifacts.map((binding) => binding.ref.artifact_id);
  if (new Set(slots).size !== slots.length) contractError("input artifact slots must be unique");
  if (new Set(ids).size !== ids.length) contractError("input artifact refs must be unique");
  return { schema_version: INPUT_ARTIFACTS_SCHEMA_VERSION, artifacts };
}

/** Append exact IDs and lineage metadata; payload bytes remain in the store. */
export function appendInputArtifactInstruction(
  task: string,
  input: InputArtifactsV2,
  budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET
): string {
  if (input.artifacts.length === 0) return task;
  const bindings = input.artifacts.map(
    (binding) => `- slot ${JSON.stringify(binding.slot)}: ${canonicalArtifactJson(binding.ref)}`
  );
  const instruction = [
    "Exact input artifacts are task material.",
    "Read each needed ID with artifact_read and repeat with next_range until truncated is false.",
    "Do not search memory, /tmp, or the repository for another agent's output.",
    ...bindings,
  ].join("\n");
  enforceToolResultBudget(
    createTextToolResult({
      schema_version: INPUT_ARTIFACTS_SCHEMA_VERSION,
      type: "artifact_handoff",
      instruction,
    }),
    budget
  );
  return `${task}\n\n${instruction}`;
}

export function replacePreviousWithArtifact(
  task: string,
  input: InputArtifactsV2,
  budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET
): string {
  const marker =
    input.artifacts.length > 0
      ? "the exact prior output identified by the input artifact below"
      : "the prior output (missing_input: no artifact ID was supplied)";
  return appendInputArtifactInstruction(task.replaceAll("{previous}", marker), input, budget);
}

export function singleArtifactInput(options: {
  slot: string;
  ref: ArtifactRef | unknown;
}): InputArtifactsV2 {
  return parseInputArtifacts({
    schema_version: INPUT_ARTIFACTS_SCHEMA_VERSION,
    artifacts: [{ slot: options.slot, ref: options.ref }],
  });
}
