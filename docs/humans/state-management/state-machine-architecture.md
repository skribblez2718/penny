# State Machine Architecture

Penny separates three responsibilities:

1. **Playbook:** domain states, happy routing, valid-gap classification, domain bookkeeping, gates, terminal candidates.
2. **Registration:** required guidance, state/agent/result contracts, state-aware repair routes, completion criteria.
3. **Engine/checkpointer:** closed requests, repair budgets/transitions, durable control state, receipts, admission, recovery.
4. **Artifact plane:** exact input-ID verification and mandatory output persistence/re-read.
5. **Child-workflow state owner:** concrete project-bound artifact verification plus one atomic
   parent-visit, parent-suspension, ordinary-child-run, initial-event, canonical call-record
   reservation, and terminal-consumption boundary. Exact retries adopt; changed operands conflict;
   missing linkage is never synthesized.
6. **Child runtime owner:** the normal depth-one service path that drives a reserved child through
   the standard engine and runner, validates its terminal core, and atomically resumes the parent
   without granting parent success.

Ordinary services construct the child owner by default, while a host can explicitly disable it. The
path is digest-bound to the six ordinary workflows (knowledge-base is excluded), has fixed
project/call admission, and applies a content-free inactivity lease. It uses each child's registered
repair/liveness policy and the service-wide step backstop instead of a predicted per-call resource
allocation. It forwards runner-signal and concurrent durable-parent cancellation; lease expiry
also stops a silent child. Child gates, arbitrary post-capture restart reconciliation, artifact/
receipt/session cohort retention, promotion, and live qualification remain separate. Gate 2 is
explicitly unrun, so active execution is not itself qualification evidence.

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
