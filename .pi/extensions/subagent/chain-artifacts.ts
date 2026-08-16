import { createHash } from "node:crypto";

import type { ToolResultBudget } from "../lib/tool-result-budget.js";
import {
  canonicalArtifactJson,
  persistArtifactOutput,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../artifacts/owner-client.js";
import {
  buildArtifactInvocationEnvironment,
  replacePreviousWithArtifact,
  singleArtifactInput,
  type InputArtifactsV1,
} from "../artifacts/handoff.js";

const DIRECT_CHAIN_MEDIA_TYPE = "text/markdown; charset=utf-8";

export function directChainConsumer(stepNumber: number): string {
  return `subagent-chain:step:${stepNumber.toString().padStart(4, "0")}`;
}

export function directChainOutputMetadata(options: {
  runId: string;
  stepIndex: number;
  totalSteps: number;
  agent: string;
  previousRef?: ArtifactRef;
}): OutputArtifactMetadata {
  const stepNumber = options.stepIndex + 1;
  const phase = `chain-step-${stepNumber.toString().padStart(4, "0")}`;
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
  pythonPath: string;
  metadata: OutputArtifactMetadata;
  output: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  return persistArtifactOutput(options);
}
