# Skill Overview — Artifact-first engine workflows

## What

A skill is an established workflow whose durable state, gates, retries, fan-out,
or recovery behavior earns orchestration overhead. Each workflow is a registered
TypeScript `PlaybookCoreV1` implementation in `apps/orchestration/`;
`.pi/skills/<name>/` contains the discoverable manifest, Domain Guidance, and resources.

## Rules

1. Pi discovers manifests from `.pi/skills/*/SKILL.md`.
2. The registered playbook owns states, contracts, routing, and terminal truth.
3. Skill directories contain no executable runtime or delegate.
4. Every cognitive stage receives exact execution-owner `input_artifacts` and an
   `output_artifact` contract. Workers read grants with `artifact_read` and
   return complete stage content before the routing `SUMMARY`.
5. The checkpointer stores compact run state and selected refs; artifact payload
   bytes never enter `RunContext`.
6. Durable memory is optional. It may support primary cross-session recall and
   curated knowledge, but workers have no memory tools and memory is never
   active handoff, run state, or persistence proof.
7. Recovery reissues pending work from checkpointed refs. Large artifact reads
   use typed, byte-exact continuation.

## Skill vs. agent vs. direct

| Path   | Use when                                                                     |
| ------ | ---------------------------------------------------------------------------- |
| Direct | Current context and tools are sufficient.                                    |
| Agent  | A separate role/context or independent judgment pays.                        |
| Skill  | Established durable state, gates, retries, fan-out, or resume semantics pay. |

## Verification

- [ ] Manifest sets `metadata.penny.engine: orchestration`.
- [ ] Playbook is registered and tested.
- [ ] Skill directory contains no executable delegate.
- [ ] Stage directives use exact artifact contracts.
- [ ] Workers receive no memory tools or room instructions.
- [ ] Terminal result exposes the selected exact product ref and honest warnings.

## Files

| File                                    | Purpose                     |
| --------------------------------------- | --------------------------- |
| `docs/agents/skills/skill-standard.md`  | Full standard               |
| `docs/agents/skills/orchestration.md`   | Engine and handoff protocol |
| `docs/agents/skills/skill-md-format.md` | Manifest format             |
| `docs/agents/skills/testing.md`         | Tests                       |
