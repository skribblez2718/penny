import { randomBytes } from "node:crypto";

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

export const INPUT_ARTIFACTS_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_GRANT_TTL_MS = 15 * 60 * 1_000;

const INPUT_ARTIFACT_FIELDS = ["schema_version", "run_id", "consumer", "artifacts"] as const;
const INPUT_ARTIFACT_BINDING_FIELDS = ["slot", "ref"] as const;
const CURSOR_HMAC_KEY_BYTES = 32;

export interface InputArtifactBinding {
  slot: string;
  ref: ArtifactRef;
}

export interface InputArtifactsV1 {
  schema_version: 1;
  run_id: string;
  consumer: string;
  artifacts: InputArtifactBinding[];
}

export interface InputArtifactExpectation {
  runId: string;
  consumer: string;
}

interface InvocationEnvironmentOptions {
  now?: number;
  cursorKey?: Buffer;
}

function contractError(message: string): never {
  throw new ArtifactClientError("ARTIFACT_CONTRACT_INVALID", message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    contractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    hasUnpairedSurrogate(value) ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    contractError(`${field} must be a non-empty canonical string`);
  }
  return value;
}

/** Parse the closed directive input_artifacts v1 contract and bind it to this action. */
export function parseInputArtifacts(
  value: unknown,
  expected?: InputArtifactExpectation
): InputArtifactsV1 {
  const record = asObject(value, "input_artifacts");
  exactKeys(record, INPUT_ARTIFACT_FIELDS, "input_artifacts");
  if (record.schema_version !== INPUT_ARTIFACTS_SCHEMA_VERSION) {
    contractError("unsupported input_artifacts schema version");
  }
  const runId = canonicalString(record.run_id, "input_artifacts.run_id");
  const consumer = canonicalString(record.consumer, "input_artifacts.consumer");
  if (!Array.isArray(record.artifacts)) {
    contractError("input_artifacts.artifacts must be an array");
  }

  const artifacts = record.artifacts.map((value, index): InputArtifactBinding => {
    const label = `input_artifacts.artifacts[${index}]`;
    const binding = asObject(value, label);
    exactKeys(binding, INPUT_ARTIFACT_BINDING_FIELDS, label);
    const slot = canonicalString(binding.slot, `${label}.slot`);
    let ref: ArtifactRef;
    try {
      ref = parseArtifactRef(binding.ref);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid ArtifactRef";
      contractError(`${label}.ref is invalid: ${detail}`);
    }
    return { slot, ref };
  });

  const slots = artifacts.map((binding) => binding.slot);
  if (new Set(slots).size !== slots.length) {
    contractError("input artifact slots must be unique");
  }
  const artifactIds = artifacts.map((binding) => binding.ref.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    contractError("input artifact refs must be unique");
  }
  for (const binding of artifacts) {
    if (binding.ref.run_id !== runId) {
      contractError("input artifact refs must belong to the directive run");
    }
    if (!binding.ref.consumer_scope.includes(consumer)) {
      contractError("input artifact ref does not grant the consumer");
    }
  }
  if (expected && (runId !== expected.runId || consumer !== expected.consumer)) {
    contractError("input_artifacts does not match the trusted action identity");
  }

  return {
    schema_version: INPUT_ARTIFACTS_SCHEMA_VERSION,
    run_id: runId,
    consumer,
    artifacts,
  };
}

/**
 * Append only exact slot/ref metadata; artifact payload bytes remain in the store.
 *
 * The complete injected handoff is measured with the same hard result-budget
 * helper as artifact_read. A ref set that cannot fit fails closed rather than
 * silently dropping authority metadata or flooding the next worker's context.
 */
export function appendInputArtifactInstruction(
  task: string,
  input: InputArtifactsV1,
  budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET
): string {
  if (input.artifacts.length === 0) return task;
  const bindings = input.artifacts.map(
    (binding) => `- slot ${JSON.stringify(binding.slot)}: ${canonicalArtifactJson(binding.ref)}`
  );
  const instruction = [
    "Exact input artifacts are authoritative.",
    "Use artifact_read with the granted ref; continue with its cursor until truncated is false.",
    "Do not infer missing bytes from this task or treat any inline preview as authoritative.",
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

/** Replace the legacy payload placeholder with a bounded exact-artifact marker. */
export function replacePreviousWithArtifact(
  task: string,
  input: InputArtifactsV1,
  budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET
): string {
  const marker =
    input.artifacts.length > 0
      ? "the exact prior output available through the granted artifact below"
      : "";
  return appendInputArtifactInstruction(task.replaceAll("{previous}", marker), input, budget);
}

/** Build one exact owner grant without accepting grant fields from model text. */
export function singleArtifactInput(options: {
  runId: string;
  consumer: string;
  slot: string;
  ref: ArtifactRef | unknown;
}): InputArtifactsV1 {
  return parseInputArtifacts({
    schema_version: INPUT_ARTIFACTS_SCHEMA_VERSION,
    run_id: options.runId,
    consumer: options.consumer,
    artifacts: [{ slot: options.slot, ref: options.ref }],
  });
}

/** Build the per-worker trusted artifact environment from only this state's exact refs. */
export function buildArtifactInvocationEnvironment(
  input: InputArtifactsV1,
  invocationIdValue: string,
  options: InvocationEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  if (input.artifacts.length === 0) {
    return {
      PENNY_ARTIFACT_INVOCATION_JSON: undefined,
      PENNY_ARTIFACT_INVOCATION_FILE: undefined,
      PENNY_ARTIFACT_CURSOR_HMAC_KEY: undefined,
    };
  }

  const invocationId = canonicalString(invocationIdValue, "artifact invocation_id");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    contractError("artifact invocation time must be a non-negative safe integer");
  }
  const cursorKey = options.cursorKey
    ? Buffer.from(options.cursorKey)
    : randomBytes(CURSOR_HMAC_KEY_BYTES);
  if (cursorKey.length < CURSOR_HMAC_KEY_BYTES) {
    contractError(`artifact cursor HMAC key must be at least ${CURSOR_HMAC_KEY_BYTES} bytes`);
  }
  const expiresAt = new Date(now + ARTIFACT_GRANT_TTL_MS).toISOString();
  const invocation = {
    schema_version: INPUT_ARTIFACTS_SCHEMA_VERSION,
    caller: {
      run_id: input.run_id,
      consumer_ref: input.consumer,
      invocation_id: invocationId,
    },
    grants: input.artifacts.map((binding) => ({
      artifact: binding.ref,
      expires_at: expiresAt,
    })),
  };

  return {
    PENNY_ARTIFACT_INVOCATION_JSON: canonicalArtifactJson(invocation),
    PENNY_ARTIFACT_INVOCATION_FILE: undefined,
    PENNY_ARTIFACT_CURSOR_HMAC_KEY: cursorKey.toString("base64url"),
  };
}
