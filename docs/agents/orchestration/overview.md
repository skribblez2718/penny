# Orchestration Package — TypeScript execution engine

## What

`apps/orchestration` is Penny’s sole workflow runtime. It provides a registry of
`PlaybookCoreV1` implementations, closed request/directive contracts, durable Node SQLite
checkpoints, exact artifacts, signed worker receipts, recovery, gates, and observability.

The skill extension constructs `OrchestrationService` in-process for single, parallel,
chain, and resume modes. Skills contain manifests, prompts, and resources—never executable
delegates.

## Components

| Module                        | Role                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `engine.ts`                   | Closed request handling, playbook dispatch, transitions, receipts, gates, recovery |
| `service.ts`                  | Engine/checkpointer/artifact/worker composition                                    |
| `checkpointer.ts`             | Owner-only Node SQLite state keyed by exact `run_id`                               |
| `artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                        |
| `worker.ts`                   | Bounded Pi SDK execution, owner capture, fan-out, signed receipts                  |
| `model-client.ts`             | Agent SSOT tools/models, trust posture, phase guidance                             |
| `playbooks/registry.ts`       | Fail-closed playbook construction                                                  |
| `playbooks/research.ts`       | Research machine                                                                   |
| `playbooks/knowledge-base.ts` | Knowledge-base machine and host-only gates                                         |
| `observability.ts`            | Best-effort metadata/digest events                                                 |

## Rules

1. The request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and `cancel`.
2. Every cognitive directive carries exact input refs and output metadata.
3. The owner persists complete worker bytes and signs a receipt before routing.
4. `RunContext` stores refs, never payload bytes.
5. Playbooks classify domain gaps; the engine enforces contracts, budgets, authority, and terminal gates.
6. Recovery is exact-run and forward-only. It never scans semantic memory.
7. Compaction reads only caller-supplied run IDs from the TypeScript v2 database.
8. `PENNY_ARTIFACT_DISPATCH_MODE=paused` preserves pending state and blocks new dispatch.
9. Unknown playbooks, requests, trust profiles, contract fields, and dispatch modes fail closed.
10. Production model/tool authority comes from `.pi/agents/*.md`; test overrides do not mutate it.

## Composition

Parallel skill invocations create independent TypeScript runs. Chain composition persists
the prior terminal bytes into an immutable `chain_input` artifact bound to the next run.
The next entry state receives only that exact grant; `{previous}` is never payload transport.
Durable chain checkpoints retain terminal and ingress refs across restart.

## Persistence

- Database: `$PROJECT_ROOT/.penny/orchestration-v2.db` unless `PENNY_ORCH_V2_DB` is set.
- Artifacts: `PENNY_ARTIFACT_ROOT`, otherwise XDG/platform state.
- Retired checkpoints are archived separately, not converted and not used as fallback.

## Verification

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/compaction test:unit
```
