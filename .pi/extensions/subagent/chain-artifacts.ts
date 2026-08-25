import { createHash } from "node:crypto";

import type { ToolResultBudget } from "../lib/tool-result-budget.js";
import {
  canonicalArtifactJson,
  persistArtifactOutput,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../artifacts/owner-client.js";
import {
  parseInputArtifacts,
  replacePreviousWithArtifact,
  type InputArtifactsV2,
} from "../artifacts/handoff.js";

const DIRECT_CHAIN_MEDIA_TYPE = "text/markdown; charset=utf-8";

export function directChainPhase(stepNumber: number): string {
  return `chain-step-${stepNumber.toString().padStart(4, "0")}`;
}

export function directChainOutputMetadata(options: {
  runId: string;
  stepIndex: number;
  agent: string;
  upstreamRefs?: readonly ArtifactRef[];
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
    schema_version: 2,
    run_id: options.runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: `subagent-chain-operation:${operationDigest}`,
    version: 1,
    producer: `agent:${options.agent}`,
    media_type: DIRECT_CHAIN_MEDIA_TYPE,
    parent_ref: null,
    upstream_refs: [...(options.upstreamRefs ?? [])],
  };
}

export function directChainInput(options: {
  previousRef?: ArtifactRef;
  additionalRefs?: readonly ArtifactRef[];
}): InputArtifactsV2 {
  const refs = [
    ...(options.previousRef ? [options.previousRef] : []),
    ...(options.additionalRefs ?? []),
  ];
  const unique = [...new Map(refs.map((ref) => [ref.artifact_id, ref])).values()];
  return parseInputArtifacts({
    schema_version: 2,
    artifacts: unique.map((ref, index) => ({
      slot:
        options.previousRef?.artifact_id === ref.artifact_id
          ? "previous-step-output"
          : `additional-input-${String(index + 1).padStart(4, "0")}`,
      ref,
    })),
  });
}

export function directChainTask(options: {
  task: string;
  input: InputArtifactsV2;
  budget: ToolResultBudget;
}): string {
  return replacePreviousWithArtifact(options.task, options.input, options.budget);
}

export async function persistDirectChainOutput(options: {
  metadata: OutputArtifactMetadata;
  output: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  return persistArtifactOutput(options);
}

export function directAgentOutputMetadata(options: {
  runId: string;
  index: number;
  agent: string;
  upstreamRefs?: readonly ArtifactRef[];
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
    schema_version: 2,
    run_id: options.runId,
    phase,
    branch_id: null,
    kind: "agent-output",
    operation_id: `subagent-operation:${operationDigest}`,
    version: 1,
    producer: `agent:${options.agent}`,
    media_type: DIRECT_CHAIN_MEDIA_TYPE,
    parent_ref: null,
    upstream_refs: [...(options.upstreamRefs ?? [])],
  };
}
