# Skill Overview — Artifact-first engine workflows

## What

A skill is an established workflow whose durable state, gates, retries, fan-out,
or recovery behavior earns orchestration overhead. Each workflow is a registered
TypeScript `PlaybookCoreV1` implementation in `apps/orchestration/`;
`.pi/skills/<name>/` contains the discoverable manifest, Domain Guidance, and resources.

## Rules

1. `.pi/skills/*/SKILL.md` is the only package source. Discovery parses all packages once; the
   sole executable registry is `PLAYBOOK_REGISTRY`.
2. The registered playbook owns states, contracts, routing, and terminal truth.
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
8. Model visibility is controlled only by `disable-model-invocation`. A model-visible package
   omits the flag; only a hidden package declares it, exactly as `true`. Redundant `false` is not
   permitted. `.pi/skills/.ignore` exactly mirrors explicitly model-disabled packages and is
   comment-only when none exist. A model-disabled package may remain unregistered during
   development, but generic execution then refuses safely.
9. Penny skill manifests do not declare the upstream optional `license` field. The repository-level
   license governs tracked packages.

## Child-workflow authority status

The active registry carries a static runtime parent/provider authority projection for exactly the
six explicitly authorized ordinary workflows: `assess`, `decide`, `diagnose`, `plan`, `produce`, and
`research`. Every one has the same all-six, one-call, depth-one parent policy and its own native
request/output plus fixed phase-authority provider declaration. The projection participates in the
runtime registration digest. Absence and unknown or dedicated workflows deny; `knowledge-base`
remains excluded. This authority is registry-owned and must not be added to `SKILL.md` or inferred
from model visibility.

`apps/orchestration/src/child-workflows/` provides bounded exact-byte contracts plus the active
storage/custody/runtime owner. Ordinary services construct that owner by default; hosts may disable
it explicitly. `WorkerExecutor` still refuses child directives directly, while the runner delegates
them to the owner. New calls deliberately omit predicted turn/tool/external/output/step/time
allocations, aggregate capacity, and parent reserve. The child uses its registered repair/liveness
policy and the service-wide step backstop plus a content-free child-execution inactivity lease; the
owner drives the registered child engine/runner, validates a terminal core, and atomically consumes
it into the parent. Fixed project/call admission, lease expiry, and cancellation forwarding are
enforced. Child gates, arbitrary post-capture restart
reconciliation, cohort retention, promotion, and live qualification remain unimplemented. Gate 2 is
explicitly `not_run`.

## Skill vs. agent vs. direct

| Path   | Use when                                                                     |
| ------ | ---------------------------------------------------------------------------- |
| Direct | Current context and tools are sufficient.                                    |
| Agent  | A separate role/context or independent judgment pays.                        |
| Skill  | Established durable state, gates, retries, fan-out, or resume semantics pay. |

## Verification

- [ ] Manifest sets `metadata.penny.engine: orchestration`, omits `license`, and declares
      `disable-model-invocation` only as `true` for a hidden package.
- [ ] Playbook is registered and tested.
- [ ] Skill directory contains no executable delegate.
- [ ] Stage directives use exact artifact contracts.
- [ ] Worker memory tools, when declared, remain read-only and never carry workflow output.
- [ ] Terminal result exposes the selected exact product ref and honest warnings.

## Files

| File                                    | Purpose                     |
| --------------------------------------- | --------------------------- |
| `docs/agents/skills/skill-standard.md`  | Full standard               |
| `docs/agents/skills/orchestration.md`   | Engine and handoff protocol |
| `docs/agents/skills/skill-md-format.md` | Manifest format             |
| `docs/agents/skills/testing.md`         | Tests                       |
