import { createHash } from "node:crypto";

import {
  canonicalArtifactJson,
  persistArtifactOutput,
  readArtifactOutput,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "./artifact-client.js";
import { singleArtifactInput, type InputArtifactsV1 } from "./input-artifacts.js";

const SKILL_CHAIN_MEDIA_TYPE = "text/markdown; charset=utf-8";

export function skillChainConsumer(chainRunId: string, stepIndex: number): string {
  return `skill-chain:${chainRunId}:step:${(stepIndex + 1).toString().padStart(4, "0")}`;
}

export function skillChainInput(options: {
  chainRunId: string;
  stepIndex: number;
  handoffRef: ArtifactRef;
}): InputArtifactsV1 {
  return singleArtifactInput({
    runId: options.chainRunId,
    consumer: skillChainConsumer(options.chainRunId, options.stepIndex),
    slot: "previous-skill-terminal-output",
    ref: options.handoffRef,
  });
}

/**
 * Re-register exact terminal bytes under the chain owner's run so the next
 * skill receives a correctly run/consumer-bound grant. The original terminal
 * ref remains the checkpoint authority; the chain ref is a content-addressed,
 * immutable handoff projection with the same digest and length.
 */
export async function persistSkillChainHandoff(options: {
  pythonPath: string;
  chainRunId: string;
  completedStepIndex: number;
  nextStepIndex: number;
  skillName: string;
  terminalRef: ArtifactRef;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  const exactBytes = await readArtifactOutput({ ref: options.terminalRef, env: options.env });
  const phase = `skill-chain-step-${(options.completedStepIndex + 1).toString().padStart(4, "0")}`;
  const operationDigest = createHash("sha256")
    .update(
      canonicalArtifactJson({
        chain_run_id: options.chainRunId,
        completed_step: options.completedStepIndex,
        source_artifact_id: options.terminalRef.artifact_id,
      }),
      "utf8"
    )
    .digest("hex");
  const metadata: OutputArtifactMetadata = {
    schema_version: 1,
    run_id: options.chainRunId,
    phase,
    branch_id: null,
    kind: "skill-output",
    operation_id: `skill-chain-operation:${operationDigest}`,
    version: 1,
    producer: `skill:${options.skillName}`,
    consumer_scope: [skillChainConsumer(options.chainRunId, options.nextStepIndex)],
    media_type: SKILL_CHAIN_MEDIA_TYPE,
    parent_ref: null,
    upstream_refs: [],
  };
  return persistArtifactOutput({
    pythonPath: options.pythonPath,
    metadata,
    output: exactBytes,
    cwd: options.cwd,
    env: options.env,
  });
}

/** Validate that a durable checkpoint ref still resolves to the exact bytes. */
export async function validateSkillChainHandoff(
  ref: ArtifactRef,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  await readArtifactOutput({ ref, env });
}
