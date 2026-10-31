# Skill Overview — Artifact-first engine workflows

## What

A skill is an established workflow whose durable state, gates, retries, fan-out,
or recovery behavior earns orchestration overhead. Each workflow is a registered
TypeScript `PlaybookCore` implementation in `apps/orchestration/`;
`.pi/skills/<name>/` contains the discoverable manifest, Domain Guidance, and resources.

## Rules

1. `.pi/skills/*/SKILL.md` is the only package source. Discovery parses all packages once; the
   sole executable registry is `PLAYBOOK_REGISTRY`.
2. The playbook proposes terminal candidates; the registration declares completion policy;
   the engine admits positive terminals and records honest refusals.
3. Skill directories contain no executable runtime or delegate.
4. Every cognitive stage receives exact cross-run `input_artifacts` IDs/refs and an
   `output_artifact` contract. Workers read needed IDs with `artifact_read` and
   return complete stage content before the routing `SUMMARY`.
5. The checkpointer stores compact run state and selected refs; artifact payload
   bytes never enter `RunContext`.
6. Durable memory is optional advisory recall. Workers may use YAML-declared read-only
   memory tools, but memory is never active handoff, run state, or persistence proof.
7. Recovery reissues pending work from checkpointed refs. Large artifact reads
   repeat with non-expiring `next_range`.
8. Manifest YAML, visibility, and license rules belong to
   [SKILL.md Format](skill-md-format.md). Discovery does not grant execution authority.

## Explicit nonbinding context

The seven ordinary skills accept each other's current accepted terminal products through
`context_artifacts`. In a chain, set `previous_artifact_designation: "context"` on the consumer
to treat the automatic predecessor that way. Native `input_artifacts` and default chain behavior
keep their existing typed requirements and assurance. A contextual specification is not a
revision subject or reviewed-definition binding; a contextual research core is not automatically
admitted evidence. The shared engine owns exact validation, designation custody and worker
delivery. A future compatible registration opts in with
`contextual_inputs: "accepted_terminal_products_v1"`; no per-producer routing scheduler is
required. Dedicated/private registrations do not opt in implicitly. Deterministic transport tests
do not establish substantive content use or live reliability.

## Child-workflow authority status

The active registry carries a static runtime parent/provider authority projection for exactly the
seven explicitly authorized ordinary workflows: `assess`, `decide`, `define`, `diagnose`, `plan`,
`produce`, and `research`. Every one has the same all-seven, one-call, depth-one parent policy and its own native
request/output plus fixed phase-authority provider declaration. The projection participates in the
runtime registration digest. Absence and unknown or dedicated workflows deny; `knowledge-base`
remains excluded. This authority is registry-owned and must not be added to `SKILL.md` or inferred
from model visibility.

The [engine feature-status table](../orchestration/overview.md#child-workflow-feature-status)
is the status owner: storage/custody, active dispatch, projected gates, captured-terminal recovery,
and linked control/session retention are implemented; provider promotion/live qualification are
separate. Gate 2 remains `not_run` with no evidence. Storage tests or successful dispatch do not
establish qualification. The owner uses registered repair/liveness and a content-free inactivity
lease, not predicted child resource allocations; legacy V1 calls remain replay-only.

## Skill vs. agent vs. direct

| Path   | Use when                                                                     |
| ------ | ---------------------------------------------------------------------------- |
| Direct | Current context and tools are sufficient.                                    |
| Agent  | A separate role/context or independent judgment pays.                        |
| Skill  | Established durable state, gates, retries, fan-out, or resume semantics pay. |

## Verification

Use the [Skill Standard](skill-standard.md) for requirements and
[Testing](testing.md#required-coverage) for the evidence matrix. An overview or checklist is not
proof that a registration, recovery path, or terminal product has been verified.

## Files

| File                                    | Purpose                     |
| --------------------------------------- | --------------------------- |
| `docs/agents/skills/skill-standard.md`  | Full standard               |
| `docs/agents/skills/orchestration.md`   | Engine and handoff protocol |
| `docs/agents/skills/skill-md-format.md` | Manifest format             |
| `docs/agents/skills/testing.md`         | Tests                       |
