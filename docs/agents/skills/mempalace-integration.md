# Exact Artifact Handoff and Optional Memory

## Active workflow transport

[Invocation](../agents/invocation.md) owns the shared transport/capture contract: exact supplied
IDs, complete bounded reads, `missing_input:`, no discovery fallback, exact final-text concatenation,
and owner persistence/readback before SUMMARY. Apply it without adding a skill-specific protocol.

Skill composition retains selected refs through retry, clarification, restart, partial fan recovery,
and chain resume. Branches may use independent inputs; cross-run fan-in is valid.

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
storage boundary alone does not prove dispatch, result acceptance, or cohort retention. The
active runtime separately implements those controls, projected gates, and captured-terminal
recovery; see the [engine status owner](../orchestration/overview.md#child-workflow-feature-status).
Immutable artifact bytes remain preserved; Gate 2 is `not_run`.

## Invariants

- Artifact IDs are communication addresses, not grants.
- Reads are direct, exact, bounded, and non-expiring.
- There is no artifact list/search/guess surface.
- Required missing IDs/paths produce `missing_input:`.
- Successful output always has a readable persisted ID.
