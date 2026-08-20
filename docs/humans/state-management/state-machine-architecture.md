# State Machine Architecture for Skills

## Layers

1. **Playbook:** declares legal states/transitions, contracts, gates, and terminal truth.
2. **Engine/checkpointer:** validates routing data and persists compact control state by `run_id`.
3. **Execution owner/artifact plane:** grants exact inputs and captures/verifies exact output bytes.
4. **Workers:** perform cognitive stages in fresh contexts using only allowlisted tools.
5. **Primary durable memory:** optional cross-session recall/curation; outside workflow transport.

## One transition

The engine emits a directive with current-run facts, exact `input_artifacts`, and
an output contract. The owner grants only those refs. The worker calls
`artifact_read` until every input is complete and returns full stage content with
a trailing routing SUMMARY. The owner persists and verifies the exact response,
then the engine validates the SUMMARY and commits the transition.

`RunContext` contains compact routing values and canonical refs, not artifact
payloads. Parallel branches map refs by stable branch ID.

## Recovery and compaction

A fresh process loads the checkpointer and reissues pending work with the same
selected refs. Accepted sibling refs survive partial fan recovery. Clarification
returns to the producer state that can use the answer. Conversation compaction
keeps a prose orientation plus optional code-owned exact run/artifact refs, so
continuation does not need semantic search or durable memory.

## Memory and service boundaries

Workers and skill drivers expose no memory tools. The primary runtime may
retrieve or curate durable knowledge separately. Normal memory access uses one
supervised MemPalace 3.7.1 HTTP hub with no raw fallback.

## Sole runtime

All playbooks use the TypeScript engine, its Node SQLite v2 checkpoint schema, and
forward-only recovery. The closed request vocabulary includes `respond` and `cancel`.
Retired checkpoints are archived rather than converted or used as fallback.

## Truth and safety

Loops are bounded, verifier passes require evidence, and exhaustion reports
`met: false` with unresolved issues. Reissued tool states must be idempotent.
Workers have tool allowlists but no filesystem sandbox.
