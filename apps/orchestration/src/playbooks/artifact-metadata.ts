/**
 * Output-artifact metadata construction, shared by every playbook.
 *
 * This logic decides an artifact's identity and its place in the revision chain:
 * a stable `operation_id` per (run, phase, branch, kind), the next version past
 * both the selected refs and the stored ledger, and the parent ref that makes
 * the chain contiguous. None of it is research-specific — it was simply written
 * inside research because research was the only playbook.
 *
 * A second playbook needs exactly this behaviour. Copying it would put two
 * versions of the revision-chain rule in the tree, and a divergence between them
 * would corrupt artifact lineage rather than merely duplicating code.
 */

import { canonicalJson, sha256 } from "../checkpointer.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../contracts.js";
import type { ArtifactRevisionLookup } from "../artifact-store.js";
import type { RunContext } from "../context.js";

/**
 * The stable operation identity for one output slot.
 *
 * Derived from the run, phase, branch, and kind — never from attempt or version —
 * so every attempt at the same slot continues one revision chain.
 */
export function agentOperationId(input: {
  runId: string;
  phase: string;
  branchId: string | null;
}): string {
  return `agent-operation:${sha256(
    canonicalJson({
      branch_id: input.branchId,
      kind: "agent-output",
      run_id: input.runId,
      state: input.phase,
    })
  )}`;
}

export function buildOutputArtifactMetadata(input: {
  context: RunContext;
  phase: string;
  agent: string;
  branchId: string | null;
  upstreamRefs: readonly ArtifactRef[];
  revisions?: ArtifactRevisionLookup;
}): OutputArtifactMetadata {
  const { context, phase, branchId, revisions } = input;
  const operationId = agentOperationId({
    runId: context.identity.run_id,
    phase,
    branchId,
  });
  const selected = context.selectedArtifacts
    .filter(
      (ref) => ref.phase === phase && ref.branch_id === branchId && ref.operation_id === operationId
    )
    .sort((left, right) => right.version - left.version)[0];
  const selectedVersion = selected?.version ?? 0;
  const storedVersion = revisions
    ? revisions.lastVersion(context.identity.run_id, phase, branchId, "agent-output", operationId)
    : 0;
  // The immutable manifest is the revision ledger: it also contains attempts
  // persisted by a worker that was interrupted before the engine accepted the
  // result. Resolve past the ledger so a later attempt on the same output slot
  // continues the chain instead of diverging from the orphaned revision.
  const version = Math.max(selectedVersion, storedVersion) + 1;
  let parent: ArtifactRef | null = null;
  if (version > 1) {
    parent =
      revisions?.refFor(
        context.identity.run_id,
        phase,
        branchId,
        "agent-output",
        operationId,
        version - 1
      ) ?? (version - 1 === selectedVersion ? (selected ?? null) : null);
    if (parent === null) {
      throw new Error(
        `revision chain for ${operationId} is broken at v${version}: no v${version - 1} in the ledger`
      );
    }
  }
  return {
    schema_version: 2,
    run_id: context.identity.run_id,
    phase,
    branch_id: branchId,
    kind: "agent-output",
    operation_id: operationId,
    version,
    producer: `agent:${input.agent}`,
    media_type: "text/plain; charset=utf-8",
    parent_ref: parent,
    upstream_refs: [...input.upstreamRefs],
  };
}
