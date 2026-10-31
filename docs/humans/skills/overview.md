# Skills

Skills are established workflows that run on Penny's shared orchestration engine.
A skill earns its overhead when durable checkpoints, gates, retries, fan-out, or
resume behavior materially improve reliability.

Each skill has a registered TypeScript playbook for states and routing plus a small
`.pi/skills/<name>/` package for discovery, Domain Guidance, and resources. Skill
directories contain no executable delegate.

## Artifact-first handoff

Every cognitive stage gets exact owner-selected input artifacts and an output
contract. Workers read needed exact IDs with `artifact_read`, including all
continuation pages, and return complete stage content. The execution owner
captures and verifies those bytes before the state machine consumes the small
routing SUMMARY.

Checkpoints keep compact routing state and selected refs, not payload bytes.
This makes retry, clarification, restart, and compaction recovery exact rather
than dependent on semantic search.

## Memory is optional

Workers may have YAML-declared read-only recall; memory writes remain primary-only. The primary runtime may still
recall or curate durable cross-session knowledge, but memory is not workflow
handoff, run state, or persistence proof. New skills do not require a memory room
or room-manifest entry.

## Child-workflow status

Penny's active registry records static runtime parent/provider authority for the seven ordinary
workflows—assess, decide, define, diagnose, plan, produce, and research—over the same bounded depth-one,
one-call target set. The declaration binds native request/output contracts and existing fixed phase
tool/network authority. Knowledge-base remains dedicated/private and excluded; model visibility by
itself still grants nothing.

The active child owner implements dispatch, exact terminal consumption, parent-mediated child
gates and replies, waiting/captured-terminal recovery, and linked control/session retention. It uses
registered repair/liveness, a step backstop and a fenced inactivity lease rather than predicted
child allocations. Cancellation and changed-parent-selection fences prevent late continuation.
Immutable artifacts remain preserved. See [current child-workflow status](../state-management/state-management.md#current-child-workflow-status)
for the feature boundaries. Provider promotion/live qualification are separate: Gate 2 remains
`not_run`, not satisfied by storage tests or successful internal execution.

## Learn more

- [Design Methodology](design-methodology.md)
- [Skill Standard](skill-standard.md)
- [Orchestration](orchestration.md)
- [Testing](testing.md)
