# State Machine Architecture

Penny separates three responsibilities:

1. **Playbook:** domain states, happy routing, valid-gap classification, domain bookkeeping, gates, terminal candidates.
2. **Registration:** required guidance, state/agent/result contracts, state-aware repair routes, completion criteria.
3. **Engine/checkpointer:** closed requests, repair budgets/transitions, durable control state, receipts, admission, recovery.
4. **Artifact plane:** exact input-ID verification and mandatory output persistence/re-read.

A cognitive directive carries current task facts, exact `input_artifacts`, and an output
contract. Inputs may cross runs. The worker reads needed IDs with `artifact_read` and
`next_range`, returns complete content, and ends with a routing-only SUMMARY. The owner
persists/re-reads bytes before parsing that SUMMARY. Agent YAML is the maximum catalog
authority. Orchestration phases without `allowed_tools` keep requested, active, and YAML tools
exactly equal; an eligible phase may use only one fixed non-empty duplicate-free strict YAML
subset held by the active registration, bound into its canonical digest and worker metadata.
Task, trust, input, runtime, model/liveness, and optional-service state cannot select it.
Structurally valid gap evaluations cannot choose their own transition or exhaustion result.

`RunContext` stores compact values and refs, never payloads. Retry, clarification, crash
recovery, parallel fan-in, and compaction reuse exact IDs. Large compaction ref sets become
one handoff-index artifact; semantic memory and global artifact scans are not continuity
mechanisms.
