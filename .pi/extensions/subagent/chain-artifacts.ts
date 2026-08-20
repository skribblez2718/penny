import { createHash } from "node:crypto";

import type { ToolResultBudget } from "../lib/tool-result-budget.js";
import {
  canonicalArtifactJson,
  persistArtifactOutput,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../artifacts/owner-client.js";
import { OWNER_CONSUMER_REF } from "../artifacts/owner-grants.js";
import {
  buildArtifactInvocationEnvironment,
  replacePreviousWithArtifact,
  singleArtifactInput,
  type InputArtifactsV1,
} from "../artifacts/handoff.js";

const DIRECT_CHAIN_MEDIA_TYPE = "text/markdown; charset=utf-8";

/** The owner phase for one 1-based chain step. Single source of truth: the
 * grant vocabulary below is derived from it so the two cannot drift. */
export function directChainPhase(stepNumber: number): string {
  return `chain-step-${stepNumber.toString().padStart(4, "0")}`;
}

/**
 * The grant a step publishes for its successor, and the `consumer` its
 * successor presents when reading it.
 *
 * This MUST be `state:{phase}`: because a chain step declares its predecessor
 * in `upstream_refs`, both artifact stores require the upstream to grant
 * exactly `state:{consuming phase}` before the put is accepted
 * (artifacts.py `_validate` / artifact-store.ts `validateMetadata`). Any other
 * vocabulary makes every step after the first fail to persist.
 */
export function directChainConsumer(stepNumber: number): string {
  return `state:${directChainPhase(stepNumber)}`;
}

export function directChainOutputMetadata(options: {
  runId: string;
  stepIndex: number;
  totalSteps: number;
  agent: string;
  previousRef?: ArtifactRef;
}): OutputArtifactMetadata {
  const stepNumber = options.stepIndex + 1;
  const phase = directChainPhase(stepNumber);
  const operationDigest = createHash("sha256")
    .update(
      canonicalArtifactJson({
        kind: "agent-output",
        phase,
        run_id: options.runId,
        step: stepNumber,
      }),
      "utf8"
    )
    .digest("hex");
  return {
    schema_version: 1,
    run_id: options.runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: `subagent-chain-operation:${operationDigest}`,
    version: 1,
    producer: `agent:${options.agent}`,
    consumer_scope: [
      stepNumber < options.totalSteps
        ? directChainConsumer(stepNumber + 1)
        : "subagent-chain:caller",
    ],
    media_type: DIRECT_CHAIN_MEDIA_TYPE,
    parent_ref: null,
    upstream_refs: options.previousRef ? [options.previousRef] : [],
  };
}

export function directChainInput(options: {
  runId: string;
  stepIndex: number;
  previousRef?: ArtifactRef;
}): InputArtifactsV1 {
  if (!options.previousRef) {
    return {
      schema_version: 1,
      run_id: options.runId,
      consumer: directChainConsumer(options.stepIndex + 1),
      artifacts: [],
    };
  }
  return singleArtifactInput({
    runId: options.runId,
    consumer: directChainConsumer(options.stepIndex + 1),
    slot: "previous-step-output",
    ref: options.previousRef,
  });
}

export function directChainTask(options: {
  task: string;
  input: InputArtifactsV1;
  budget: ToolResultBudget;
}): string {
  return replacePreviousWithArtifact(options.task, options.input, options.budget);
}

export function directChainEnvironment(
  input: InputArtifactsV1,
  invocationId: string
): NodeJS.ProcessEnv {
  return buildArtifactInvocationEnvironment(input, invocationId);
}

export async function persistDirectChainOutput(options: {
  metadata: OutputArtifactMetadata;
  output: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  return persistArtifactOutput(options);
}

/**
 * Owner metadata for a single- or parallel-mode agent output.
 *
 * These modes have no successor worker, so the only consumer is the execution
 * owner itself. The artifact exists so the orchestrator can re-read exact agent
 * output on demand — after a bounded preview, or after compaction has dropped
 * the inline copy — instead of losing it.
 */
export function directAgentOutputMetadata(options: {
  runId: string;
  index: number;
  agent: string;
}): OutputArtifactMetadata {
  const phase = `agent-output-${(options.index + 1).toString().padStart(4, "0")}`;
  const operationDigest = createHash("sha256")
    .update(
      canonicalArtifactJson({
        kind: "agent-output",
        phase,
        run_id: options.runId,
        step: options.index + 1,
      }),
      "utf8"
    )
    .digest("hex");
  return {
    schema_version: 1,
    run_id: options.runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: `subagent-operation:${operationDigest}`,
    version: 1,
    producer: `agent:${options.agent}`,
    consumer_scope: [OWNER_CONSUMER_REF],
    media_type: DIRECT_CHAIN_MEDIA_TYPE,
    parent_ref: null,
    upstream_refs: [],
  };
}
