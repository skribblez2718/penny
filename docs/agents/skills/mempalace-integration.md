# Exact Artifact Handoff and Optional Memory

## Active workflow transport

1. The playbook selects exact predecessor IDs/refs from any run.
2. Owner code verifies every ID by manifest lookup plus digest/length before worker use.
3. The directive carries those IDs and an output contract.
4. The worker reads needed IDs with `artifact_read` plus `next_range`.
5. The worker returns complete content and a routing-only final SUMMARY.
6. Owner code persists and re-reads exact bytes before parsing routing.

Parallel branches may receive independent explicit IDs; downstream fan-in can combine
outputs from several branches/runs. Chain steps receive the prior ID automatically and may
add extra IDs.

For a stored child call, `ChildWorkflowStateOwner` mints custody from one concrete
`ArtifactStore`. The checkpointer proves that store and its own control database have
the same project binding, then re-reads the canonical request and every input by exact manifest ref,
length, digest, store ref, and object bytes before atomically recording linkage. The call row stores
compact refs/digests and control metadata, never payload bodies.

## Memory boundary

Durable memory is advisory recall and curated cross-session knowledge. It is never stage
output transport, checkpoint state, a receipt, persistence proof, or missing-predecessor
recovery. Memory outage cannot change workflow correctness.

## Recovery

Checkpoints retain compact refs. Compaction carries prose plus code-proven current-session
subagent/skill refs, exact reused inputs, or one handoff-index ID. No semantic memory or
global artifact scan participates.

Child-call storage recovery follows the same boundary. A committed exact call may be adopted after
restart; artifact-only bytes, memory, logs, or prose never synthesize a call row or child run. The
current storage slice does not dispatch children, accept results, or establish child artifact,
receipt, or session-cohort retention.

## Invariants

- Artifact IDs are communication addresses, not grants.
- Reads are direct, exact, bounded, and non-expiring.
- There is no artifact list/search/guess surface.
- Required missing IDs/paths produce `missing_input:`.
- Successful output always has a readable persisted ID.
