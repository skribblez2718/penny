# The Skill Standard

A well-formed Penny skill has:

1. a trigger-rich `SKILL.md` manifest with `engine: orchestration`, no per-skill `license`, and no
   redundant `disable-model-invocation: false`;
2. a registered TypeScript playbook and no executable delegate;
3. static Domain Guidance for each worker/state;
4. exact input/output artifact contracts for every cognitive stage;
5. complete stage output before a routing-only SUMMARY;
6. README/reference/flow documentation;
7. playbook, typed composition, handoff, memory-absent recovery, discovery, and source-guard tests.

## Registration and model visibility

A registration owns how a workflow enters, validates its request, opens workers, chooses liveness
and model posture, and proves completion. `.pi/skills` is the one package root and
`PLAYBOOK_REGISTRY` is the sole executable registry. Visibility is a separate manifest choice: any
valid package is model-visible and omits `disable-model-invocation`. Only a hidden package declares
`disable-model-invocation: true`; redundant `false` is not permitted. `.pi/skills/.ignore` exactly
mirrors explicit disablement. Penny also omits the upstream optional per-skill `license` field because
its repository-level license governs tracked packages. A model-disabled development package may
remain unregistered for documentation and static checks, but generic invocation refuses safely until
a playbook exists. Knowledge Base remains a dedicated tool rather than a generic skill entry.

## Artifact and state separation

Exact stage bytes live in immutable owner artifacts. The orchestration
checkpointer stores compact control state and selected refs. Workers read only
owner-verified exact IDs with `artifact_read` and `next_range`. Model-authored
SUMMARY fields route the workflow but never prove persistence.

## Memory-optional by construction

A manifest may describe optional primary durable-memory integration, but workers
may use YAML-declared read-only recall, while writes remain primary-only. Memory is not active handoff or run
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
