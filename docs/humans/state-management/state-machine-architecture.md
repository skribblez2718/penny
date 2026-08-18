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

## Dual runtime

Python remains the default engine. An opt-in TypeScript v2 runtime is available
for the `research` playbook during the migration pilot. Both runtimes share the
same FSM protocol, checkpointer schema, and forward-only recovery; TypeScript v2
additionally defines `respond` and `cancel` through its closed service/CLI request
schema. No default changes before the M7 approval gate.

## Truth and safety

Loops are bounded, verifier passes require evidence, and exhaustion reports
`met: false` with unresolved issues. Reissued tool states must be idempotent.
Workers have tool allowlists but no filesystem sandbox.
