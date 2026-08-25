# Orchestration Integration — TypeScript playbooks

## Model

Every workflow skill is a registered `PlaybookCoreV1` implementation. The skill extension
constructs `OrchestrationService` in-process; skill directories contain no runtime.

```text
skill tool
  → OrchestrationService
    → closed request
    → playbook directive
    → Pi SDK worker / host gate
    → immutable artifact + signed receipt
    → checkpointed transition
```

## Responsibilities

| Layer                    | Responsibility                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| Skill manifest/resources | Discovery, prompts, durable domain reference                                     |
| Playbook                 | State vocabulary, input selection, routing, repairs, gates, terminal result      |
| Engine                   | Contract/authority checks, checkpoints, receipts, recovery, completion admission |
| Worker                   | Exact input reads and complete stage output                                      |
| ArtifactStore            | Immutable bytes, lineage metadata, versions, and direct exact-ID reads           |

## Requests

- `start`: create one exact-run checkpoint and emit the first directive.
- `step`: accept one signed phase result and route.
- `respond`: answer the exact pending gate challenge.
- `recover`: reissue pending work from the checkpoint.
- `status`: return a safe state projection.
- `cancel`: terminate without pretending completion.

## Rules

1. Run identity is immutable and TypeScript-owned.
2. Control state lives only in the Node SQLite checkpoint.
3. Every worker assignment has closed input and output artifact contracts.
4. Owner capture and receipt validation precede routing.
5. Playbook data is bounded JSON; product bytes remain in artifacts.
6. Gates and escalation emit `await_user`; only `respond` can continue them.
7. Repairs are explicit successor states and have finite budgets.
8. Recovery is exact-run, idempotent, and memory-independent.
9. Composition verifies and forwards exact predecessor IDs directly across runs.

## Verification

- [ ] Playbook is registered and contract-valid.
- [ ] Start/step/respond/recover/cancel all fail closed on wrong identity.
- [ ] Missing/corrupt input IDs are rejected before worker use; cross-run fan-in succeeds.
- [ ] Crash and partial-fan recovery preserve exact refs.
- [ ] Gate payload/challenge binds the response.
- [ ] Positive terminals satisfy `CompletionGateV1`.

## Files

- `apps/orchestration/src/service.ts`
- `apps/orchestration/src/engine.ts`
- `apps/orchestration/src/playbooks/playbook.ts`
- `apps/orchestration/src/playbooks/registry.ts`
- `apps/orchestration/src/checkpointer.ts`
- `apps/orchestration/src/artifact-store.ts`
