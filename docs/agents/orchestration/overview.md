# Orchestration Package — TypeScript execution engine

## What

`apps/orchestration` is Penny’s sole workflow runtime. It provides a registry of
`PlaybookCoreV1` implementations, closed request/directive contracts, durable Node SQLite
checkpoints, exact artifacts, signed worker receipts, recovery, gates, and observability.

The skill extension constructs `OrchestrationService` in-process for single, parallel,
chain, and resume modes. Skills contain manifests, prompts, and resources—never executable
delegates.

## Components

| Module                        | Role                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `engine.ts`                   | Closed request handling, playbook dispatch, transitions, receipts, gates, recovery                 |
| `service.ts`                  | Engine/checkpointer/artifact/worker composition                                                    |
| `checkpointer.ts`             | Owner-only Node SQLite state keyed by exact `run_id`; canonical content-review packet/receipt rows |
| `artifact-store.ts`           | Immutable manifest and content-addressed exact-byte objects                                        |
| `worker.ts`                   | Bounded Pi SDK execution, owner capture, fan-out, signed receipts                                  |
| `model-client.ts`             | Agent SSOT tools/models, trust posture, phase guidance                                             |
| `playbooks/registry.ts`       | Fail-closed playbook construction                                                                  |
| `playbooks/research.ts`       | Research machine                                                                                   |
| `playbooks/knowledge-base.ts` | Knowledge-base machine and host-only gates                                                         |
| `observability.ts`            | Best-effort metadata/digest events                                                                 |

## Rules

1. The request vocabulary is `start`, `step`, `status`, `recover`, `respond`, and `cancel`.
2. Every cognitive directive carries exact input refs and output metadata.
3. The owner persists complete worker bytes and signs a receipt before routing.
4. `RunContext` stores refs, never payload bytes.
5. Playbooks classify domain gaps; the engine enforces contracts, budgets, authority, and terminal gates.
6. Recovery is exact-run and forward-only. It never scans semantic memory.
7. Compaction reads only caller-supplied run IDs from the catalog-bound unversioned orchestration database.
8. `PENNY_ARTIFACT_DISPATCH_MODE=paused` preserves pending state and blocks new dispatch.
9. Unknown playbooks, requests, trust profiles, contract fields, and dispatch modes fail closed.
10. A catalog worker's active tools equal `.pi/agents/<agent>.md` YAML exactly under every trust profile; no result/artifact tool is injected.

## Composition

Parallel skill invocations create independent TypeScript runs. Chain composition verifies
and forwards the prior terminal artifact ID directly across runs. The next entry state may
also receive additional explicit fan-in IDs; `{previous}` is never payload transport.
Durable chain checkpoints retain exact terminal/handoff refs across restart.

## Persistence

- State root: `${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}`; Pi relocation follows `PI_CODING_AGENT_DIR`.
- Database: `projects/<opaque-project-id>/orchestration/orchestration.db`. It uses WAL, `synchronous=FULL`, bounded busy timeout, project metadata, and co-locates ingest/save content-review packets and receipts with their runs/gates.
- Receipt key: the same partition's `orchestration/receipt-key`; exact key bytes must survive migration.
- Artifacts: the same partition's `artifacts/manifest.db` plus content-addressed objects.
- Chains and subagent sessions: the same project partition, with project-bound checkpoints and durable Pi JSONL.
- Retired selectors and roots are rejected; ordinary runtime performs no scan, import, or fallback.

## Verification

```bash
bun run --cwd apps/orchestration build
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/compaction test:unit
```
