# Skill Orchestration

Penny has one TypeScript workflow engine. A registered playbook names states, routing,
contracts, repairs, gates, and terminal truth; the engine owns checkpoints, exact artifacts,
receipts, workers, and recovery.

## One stage

1. The playbook selects exact predecessor refs.
2. The engine emits a closed worker directive.
3. The worker reads each needed exact ID through `next_range`.
4. The owner persists/re-reads complete output bytes and signs a receipt.
5. Only then may routing fields advance the checkpoint.

Parallel work uses branch IDs. Chain composition verifies and forwards the exact terminal
ID directly into the next run; `{previous}` never transports payload text.

## Recovery

The Node SQLite checkpointer stores compact state and selected refs, never stage payloads.
Retry, clarification, crash recovery, and compaction use exact run/artifact identities.
Retired checkpoints are archived and never converted into active runs.

## Memory boundary

Workers and skill execution do not use durable memory as handoff, run state, or persistence
proof. Primary cross-session memory remains a separate optional capability.

## Learn more

- [Skill Standard](skill-standard.md)
- [Testing](testing.md)
- [Agent Orchestration Reference](../../agents/skills/orchestration.md)
