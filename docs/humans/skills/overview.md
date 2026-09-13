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

Penny's active registry records static runtime parent/provider authority for the six ordinary
workflows—assess, decide, diagnose, plan, produce, and research—over the same bounded depth-one,
one-call target set. The declaration binds native request/output contracts and existing fixed phase
tool/network authority. Knowledge-base remains dedicated/private and excluded; model visibility by
itself still grants nothing.

Penny also has bounded validation contracts, durable parent/child linkage, and an active depth-one
child owner. Ordinary services construct it by default, while a host can explicitly disable child
execution. The owner executes an authorized registered child, validates its terminal product, and
continues the parent once. New calls avoid predicted child-specific resource ceilings and instead
use the child's registered repair/liveness policy, the service-wide step backstop, and a content-free
inactivity lease renewed only by host-observed activity or workflow progress; runner, parent, and
lease cancellation are enforced. Child gates, arbitrary post-capture restart
reconciliation, cohort retention, promotion, and live qualification remain separate. Gate 2 is
unrun, so runtime execution alone is not qualification evidence.

## Learn more

- [Design Methodology](design-methodology.md)
- [Skill Standard](skill-standard.md)
- [Orchestration](orchestration.md)
- [Testing](testing.md)
