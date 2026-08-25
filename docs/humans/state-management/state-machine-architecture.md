# State Machine Architecture

Penny separates three responsibilities:

1. **Playbook:** domain states, routing, repairs, gates, terminal truth.
2. **Engine/checkpointer:** closed requests, durable control state, receipts, recovery.
3. **Artifact plane:** exact input-ID verification and mandatory output persistence/re-read.

A cognitive directive carries current task facts, exact `input_artifacts`, and an output
contract. Inputs may cross runs. The worker reads needed IDs with `artifact_read` and
`next_range`, returns complete content, and ends with a routing-only SUMMARY. The owner
persists/re-reads bytes before parsing that SUMMARY.

`RunContext` stores compact values and refs, never payloads. Retry, clarification, crash
recovery, parallel fan-in, and compaction reuse exact IDs. Large compaction ref sets become
one handoff-index artifact; semantic memory and global artifact scans are not continuity
mechanisms.
