# Skill Orchestration

A skill's playbook names its states and legal transitions. The shared engine
validates SUMMARY contracts, checkpoints compact run state, enforces budgets and
gates, and recovers pending work. The TypeScript skill driver owns worker
invocation and exact artifact capture.

## One stage

1. The playbook selects every exact predecessor needed by the current consumer.
2. The engine emits `input_artifacts` and an output contract.
3. The driver grants only those refs and invokes a fresh worker.
4. The worker reads each grant with `artifact_read` through complete continuation
   and returns complete stage content plus a trailing routing SUMMARY.
5. The driver persists and verifies exact bytes, signs the owner receipt, and
   only then sends the SUMMARY to the engine.

Parallel work maps artifacts by branch ID, not completion order. Accepted sibling
refs survive partial recovery.

## Recovery

The SQLite checkpointer stores current state, compact routing fields, and selected
canonical refs. It never stores stage payloads. Retry, clarification, restart,
and crash recovery reissue pending work with the same exact refs. A compaction
summary can preserve code-owned run/artifact addresses so the conversation can
continue without broad discovery.

## Durable memory boundary

Workers and skill drivers have no durable-memory tools. The primary runtime may
use memory before or after a workflow when cross-session recall or curation is
valuable, but a memory endpoint is never required for workflow correctness.
Historical skill rooms are legacy corpus only.

## Learn more

- [Skills](overview.md)
- [Skill Standard](skill-standard.md)
- [Testing](testing.md)
- Agent reference: [Orchestration](../../agents/skills/orchestration.md)
