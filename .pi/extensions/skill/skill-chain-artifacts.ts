import { readArtifactOutput, type ArtifactRef } from "./artifact-client.js";
import { singleArtifactInput, type InputArtifactsV2 } from "./input-artifacts.js";

export function skillChainInput(options: {
  targetRunId: string;
  handoffRef: ArtifactRef;
}): InputArtifactsV2 {
  void options.targetRunId;
  return singleArtifactInput({
    slot: "previous-skill-terminal-output",
    ref: options.handoffRef,
  });
}

/**
 * Verify and forward the predecessor's canonical terminal ID directly.
 * Artifact communication is cross-run; no target-run copy or consumer grant is
 * necessary, and identity remains the producer's original immutable address.
 */
export async function persistSkillChainHandoff(options: {
  chainRunId: string;
  completedStepIndex: number;
  targetRunId: string;
  skillName: string;
  terminalRef: ArtifactRef;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  void options.chainRunId;
  void options.completedStepIndex;
  void options.targetRunId;
  void options.skillName;
  await readArtifactOutput({
    ref: options.terminalRef,
    projectRoot: options.projectRoot,
    env: options.env,
  });
  return options.terminalRef;
}

export async function validateSkillChainHandoff(
  ref: ArtifactRef,
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  await readArtifactOutput({ ref, projectRoot, env });
}
