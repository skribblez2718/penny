import { createHash } from "node:crypto";

import {
  ArtifactStore,
  loadRuntimeConfig,
  type OutputArtifactMetadata as TypeScriptOutputArtifactMetadata,
} from "@penny/orchestration/source";

import {
  canonicalArtifactJson,
  parseArtifactRef,
  readArtifactOutput,
  type ArtifactRef,
} from "./artifact-client.js";
import { singleArtifactInput, type InputArtifactsV1 } from "./input-artifacts.js";

const SKILL_CHAIN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const RESEARCH_ENTRY_CONSUMERS = ["state:planning", "state:researching"] as const;

/** Owner consumer used only while seeding a new TypeScript skill run. */
export function skillRunStartConsumer(targetRunId: string): string {
  return `skill-start:${targetRunId}`;
}

export function skillChainInput(options: {
  targetRunId: string;
  handoffRef: ArtifactRef;
}): InputArtifactsV1 {
  return singleArtifactInput({
    runId: options.targetRunId,
    consumer: skillRunStartConsumer(options.targetRunId),
    slot: "previous-skill-terminal-output",
    ref: options.handoffRef,
  });
}

/**
 * Import exact predecessor bytes into the next TypeScript run.
 *
 * The original terminal ref remains checkpoint authority. This target-run ref is
 * an immutable, content-addressed ingress artifact whose consumer scope admits
 * only the research entry states and the owner start seam. The TypeScript
 * ArtifactStore is the sole persistence owner; no Python child is spawned.
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
  const exactBytes = await readArtifactOutput({ ref: options.terminalRef, env: options.env });
  const operationDigest = createHash("sha256")
    .update(
      canonicalArtifactJson({
        chain_run_id: options.chainRunId,
        completed_step: options.completedStepIndex,
        source_artifact_id: options.terminalRef.artifact_id,
        target_run_id: options.targetRunId,
      }),
      "utf8"
    )
    .digest("hex");
  const consumerScope = [
    skillRunStartConsumer(options.targetRunId),
    ...RESEARCH_ENTRY_CONSUMERS,
  ].sort();
  const metadata: TypeScriptOutputArtifactMetadata = {
    schema_version: 1,
    run_id: options.targetRunId,
    phase: "chain_input",
    branch_id: null,
    kind: "agent-output",
    operation_id: `skill-chain-operation:${operationDigest}`,
    version: 1,
    producer: `skill:${options.skillName}`,
    consumer_scope: consumerScope,
    media_type: SKILL_CHAIN_MEDIA_TYPE,
    parent_ref: null,
    upstream_refs: [],
  };
  const config = loadRuntimeConfig(options.projectRoot, options.env ?? process.env);
  using store = new ArtifactStore(config.artifactRoot);
  return parseArtifactRef(store.persist({ metadata, content: exactBytes }));
}

/** Validate that a durable checkpoint ref still resolves to the exact bytes. */
export async function validateSkillChainHandoff(
  ref: ArtifactRef,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  await readArtifactOutput({ ref, env });
}
