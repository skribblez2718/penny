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

## Memory boundary

Durable memory is advisory recall and curated cross-session knowledge. It is never stage
output transport, checkpoint state, a receipt, persistence proof, or missing-predecessor
recovery. Memory outage cannot change workflow correctness.

## Recovery

Checkpoints retain compact refs. Compaction carries prose plus code-proven current-session
subagent/skill refs, exact reused inputs, or one handoff-index ID. No semantic memory or
global artifact scan participates.

## Invariants

- Artifact IDs are communication addresses, not grants.
- Reads are direct, exact, bounded, and non-expiring.
- There is no artifact list/search/guess surface.
- Required missing IDs/paths produce `missing_input:`.
- Successful output always has a readable persisted ID.
