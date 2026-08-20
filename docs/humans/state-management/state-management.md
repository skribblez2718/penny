# Skill State Management

Penny's shared orchestration engine stores run control state in a durable SQLite
checkpointer keyed by `run_id`. Each skill contributes a registered TypeScript playbook
with states, contracts, routing, gates, and terminal truth. Skill directories contain no
executable delegate.

## Three data planes

| Plane          | Owns                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| Checkpointer   | Current state, compact routing fields, selected canonical refs, status. |
| Artifact plane | Immutable exact worker/stage bytes and evidence.                        |
| Durable memory | Optional primary cross-session recall/curation, diary, and temporal KG. |

These planes do not substitute for each other. Payload bytes do not enter
`RunContext`; memory does not carry active workflow handoff.

## Recovery

Every cognitive stage receives exact owner-selected input refs. The worker reads
them with `artifact_read` through complete continuation. The owner persists and
verifies the response before SUMMARY routing. If the process stops, recovery
rehydrates the checkpoint and reissues only pending work with the same refs.

Workers and skill drivers have no memory tools, so memory availability cannot
change state-machine correctness.

## Learn more

- [Architecture](state-machine-architecture.md)
- [Patterns](state-machine-patterns.md)
- Agent reference: [State Machine Reference](../../agents/state-management/state-machine-reference.md)
