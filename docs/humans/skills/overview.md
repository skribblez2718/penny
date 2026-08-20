# Skills

Skills are established workflows that run on Penny's shared orchestration engine.
A skill earns its overhead when durable checkpoints, gates, retries, fan-out, or
resume behavior materially improve reliability.

Each skill has a registered TypeScript playbook for states and routing plus a small
`.pi/skills/<name>/` package for discovery, Domain Guidance, and resources. Skill
directories contain no executable delegate.

## Artifact-first handoff

Every cognitive stage gets exact owner-selected input artifacts and an output
contract. Workers read granted refs with `artifact_read`, including all
continuation pages, and return complete stage content. The execution owner
captures and verifies those bytes before the state machine consumes the small
routing SUMMARY.

Checkpoints keep compact routing state and selected refs, not payload bytes.
This makes retry, clarification, restart, and compaction recovery exact rather
than dependent on semantic search.

## Memory is optional

Workers and skill drivers have no memory tools. The primary runtime may still
recall or curate durable cross-session knowledge, but memory is not workflow
handoff, run state, or persistence proof. New skills do not require a memory room
or room-manifest entry.

## Learn more

- [Design Methodology](design-methodology.md)
- [Skill Standard](skill-standard.md)
- [Orchestration](orchestration.md)
- [Testing](testing.md)
