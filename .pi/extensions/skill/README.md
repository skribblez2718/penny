# Skill Invocation Extension

Drives durable TypeScript playbooks through `@penny/orchestration`.

## Architecture

```text
Penny → skill tool → TypeScript OrchestrationService
  → closed start/recover/respond request
  → Pi SDK worker(s) with exact input refs
  → TypeScript ArtifactStore persists complete output
  → signed owner receipt and routing result
  → checkpointed transition
  → terminal, clarification, or dispatch-pause boundary
```

No Python process, per-skill executable delegate, or legacy checkpoint conversion exists.

## Modes

- **Single:** one registered skill run.
- **Parallel:** independent TypeScript runs with bounded concurrency.
- **Chain:** sequential TypeScript runs with exact terminal-artifact handoff.
- **Resume:** reloads the durable owner-only chain checkpoint and resumes the failed step.

For chain handoff, the owner verifies and forwards the prior terminal artifact ID directly;
cross-run reads require no target-run copy. `{previous}` becomes a bounded instruction
identifying that ID, never payload text. Additional explicit IDs may be supplied for
multi-source fan-in. Chain checkpoints retain exact terminal/handoff refs across restart.

## Catalog visibility and entrypoints

Pi's native `<available_skills>` system section is the sole model-facing catalog of skill names, YAML descriptions, and locations. The `skill` tool describes orchestration mechanics without repeating those catalog rows. At prompt assembly, this extension replaces Pi's generic read-to-load sentence with a directive to invoke each matching skill's registered entrypoint and reserve `read` for documentation inspection.

The engine workflow entrypoint is `skill`; the knowledge-base profile deliberately exposes its separate typed `knowledge_base` entrypoint. The extension registers both tools, and unit coverage rejects registration drift.

## Model policy

Production worker models come from `.pi/agents/<agent>.md` frontmatter. `model` is an
optional per-invocation override applied to every worker in that run, primarily for tests.
It does not mutate production frontmatter. A step-level chain/parallel override is scoped
to that step.

## Artifact communication and tool authority

- Inputs are unique exact artifact IDs/refs from any run; existence and integrity are
  checked before worker execution.
- Exact finalized output bytes are persisted and immediately re-read before routing fields
  are parsed or a successful result is returned.
- Receipts bind run, state, branch, agent, attempt, trust posture, invocation digest,
  output digest, and canonical artifact ref.
- Run context stores selected refs, not payload bytes. Memory is never workflow transport.
- A catalog worker's exact active tools equal its `.pi/agents/<agent>.md` YAML `tools:` list
  under every trust profile. The runtime neither strips hardened tools nor injects result
  or artifact tools.
- Every provider extension loads before session creation. Optional-service absence is a
  typed call error, not conditional tool omission.
- Standard catalog workers return complete assistant output plus their closed `SUMMARY`
  line. Owner code parses routing only from persisted bytes; no injected
  `submit_orchestration_result` tool exists.
- KB's host-tool-matrix session is explicitly anonymous and does not load or claim a
  catalog role. Catalog-agent invocations may never replace YAML tools with that matrix.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE` accepts `active|paused`. A pause is retriable and preserves
the pending checkpoint. A fresh recovery under `active` reissues the exact selected refs
and output contract. Unknown mode values fail closed.

The TypeScript database is the current opaque project partition's unversioned
`orchestration/orchestration.db` below `${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}`.
Existing runs remain owner-sticky by `run_id`; retired Python checkpoints are archived
outside the runtime and are never a fallback. Chain checkpoints use the same project
partition and include its opaque project ID.

## KB host-grant authority

Profile-session and parent-delivery grants share one owner-only WAL/FULL database in the current
opaque project's catalog-bound `kb/host-grants` partition. There is no project-local, JSON, or
secondary-directory fallback. Unexpected legacy fragments block the authority rather than being
scanned or adopted.

`penny-kb-gate profile-grant-mint|list|revoke|expire` manages reusable, expiring exact
session/profile grants. Each adapter call consumes an immutable use bound to Pi's exact tool-call
ID, action, request digest, and observed policy digest. Parent delivery additionally uses
`parent-grant-mint|list|revoke|expire`; mint requires the exact invocation ID, provider, model, and
query request, and the resulting grant remains exact single-use by one delivered run.

## Parameters

| Parameter            | Scope       | Description                                          |
| -------------------- | ----------- | ---------------------------------------------------- |
| `skill_name`, `goal` | single      | Registered skill and objective                       |
| `session_id`         | single      | Optional stable run identity                         |
| `constraints`        | all         | Bounded skill-specific constraints                   |
| `input_artifacts`    | single/step | Unique exact IDs from any run; verified before start |
| `model`              | single/step | Test/caller worker-model override                    |
| `skills`             | parallel    | Up to three independent skill steps                  |
| `chain`              | chain       | Up to ten sequential steps                           |
| `resume_chain`       | resume      | Durable chain checkpoint ID                          |
| `step_overrides`     | resume      | Goal/constraint changes for the failed step only     |

## Testing

```bash
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/skill test:integration
bun run --cwd .pi/extensions/skill test:e2e
bun run --cwd apps/orchestration test
```

The unit suite proves every skill mode is TypeScript-only and that no Python child is
spawned. Integration tests verify discovery through `SKILL.md` plus the TypeScript
playbook registry.
