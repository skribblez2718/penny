# The Skill Standard

A well-formed Penny skill has:

1. a trigger-rich `SKILL.md` manifest with `engine: orchestration`;
2. a registered `BasePlaybook` and thin delegate;
3. static Domain Guidance for each worker/state;
4. exact input/output artifact contracts for every cognitive stage;
5. complete stage output before a routing-only SUMMARY;
6. README/reference/flow documentation;
7. playbook, handoff, memory-absent recovery, and source-guard tests.

## Artifact and state separation

Exact stage bytes live in immutable owner artifacts. The orchestration
checkpointer stores compact control state and selected refs. Workers read only
owner-granted inputs with `artifact_read` and typed continuation. Model-authored
SUMMARY fields route the workflow but never prove persistence.

## Memory-optional by construction

A manifest may describe optional primary durable-memory integration, but workers
and skill drivers receive no memory tools. Memory is not active handoff or run
state. New skills require no memory room and no entry in the historical
`skill_rooms.json` classification file.

## Why this matters

The separation makes handoff deterministic, recovery exact, and context bounded.
It also keeps durable memory high-signal: only the primary runtime performs
value-triggered recall, curated writes, diary, or governed KG operations.

## Learn more

- [Skills](overview.md)
- [Orchestration](orchestration.md)
- [Testing](testing.md)
- Agent reference: [Skill Standard](../../agents/skills/skill-standard.md)
