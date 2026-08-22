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

For chain handoff, the owner reads the exact terminal bytes and persists a target-run
`chain_input` artifact. `{previous}` becomes a bounded instruction identifying that grant;
payload text is never substituted into the goal. Chain checkpoints retain the terminal
and ingress refs across restart.

## Model policy

Production worker models come from `.pi/agents/<agent>.md` frontmatter. `model` is an
optional per-invocation override applied to every worker in that run, primarily for tests.
It does not mutate production frontmatter. A step-level chain/parallel override is scoped
to that step.

## Artifact and authority model

- Every worker receives a closed `InputArtifactsV1` grant.
- Exact finalized output bytes are persisted by the TypeScript artifact owner before
  routing fields can advance the engine.
- Receipts bind run, state, branch, agent, attempt, trust posture, invocation digest,
  output digest, and canonical artifact ref.
- Run context stores selected refs, not payload bytes.
- Memory is never workflow transport or persistence proof.
- Worker tools come from agent SSOT; hardened posture strips mutation/execution tools.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE` accepts `active|paused`. A pause is retriable and preserves
the pending checkpoint. A fresh recovery under `active` reissues the exact selected refs
and output contract. Unknown mode values fail closed.

The TypeScript database defaults to `$PROJECT_ROOT/.penny/orchestration-v2.db`. Existing
runs remain owner-sticky by `run_id`; retired Python checkpoints are archived outside the
runtime and are never converted.

## KB host-grant authority

Profile-session and parent-delivery grants share the owner-only
`$PROJECT_ROOT/.penny/kb-host-grants/grants.sqlite` WAL/FULL database. There is no JSON or
secondary-directory fallback. Unexpected legacy fragments block the authority rather than being
scanned or adopted.

`penny-kb-gate profile-grant-mint|list|revoke|expire` manages reusable, expiring exact
session/profile grants. Each adapter call consumes an immutable use bound to Pi's exact tool-call
ID, action, request digest, and observed policy digest. Parent delivery additionally uses
`parent-grant-mint|list|revoke|expire`; mint requires the exact invocation ID, provider, model, and
query request, and the resulting grant remains exact single-use by one delivered run.

## Parameters

| Parameter                    | Scope       | Description                                      |
| ---------------------------- | ----------- | ------------------------------------------------ |
| `skill_name`, `goal`         | single      | Registered skill and objective                   |
| `session_id`, `project_root` | single      | Optional stable identity and target root         |
| `constraints`                | all         | Bounded skill-specific constraints               |
| `model`                      | single/step | Test/caller worker-model override                |
| `skills`                     | parallel    | Up to three independent skill steps              |
| `chain`                      | chain       | Up to ten sequential steps                       |
| `resume_chain`               | resume      | Durable chain checkpoint ID                      |
| `step_overrides`             | resume      | Goal/constraint changes for the failed step only |

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
