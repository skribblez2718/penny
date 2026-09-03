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

| Layer                    | Responsibility                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Skill manifest/resources | Discovery, prompts, durable domain reference                                                                  |
| Playbook                 | State vocabulary, input selection, gap classification, domain bookkeeping, gates, terminal result             |
| Registration             | Required guidance, state/agent/result contracts, optional fixed phase subsets, repair routes, completion gate |
| Engine                   | Contract/digest checks, repair budgets/transitions, checkpoints, receipts, recovery, completion admission     |
| Worker                   | Registration binding, exact input reads, YAML/default or strict-subset tools, and complete stage output       |
| ArtifactStore            | Immutable bytes, lineage metadata, versions, and direct exact-ID reads                                        |

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
7. A structurally valid gap returns content-only `EvaluationResultV2`; it cannot select a
   state or exhaustion result. Registered routes and engine-owned finite budgets determine both.
8. Repair bookkeeping cannot mutate state ID/history, step count, pending/terminal directives,
   status, or `met`; route events contain digests and counters only.
9. Structural malformed results use the separate bounded P1.2 routing-repair path.
10. Recovery is exact-run, idempotent, and memory-independent.
11. Composition verifies and forwards exact predecessor IDs directly across runs.
12. Every new `complete/status=complete/met:true` candidate passes the one engine-owned
    admission helper, including start, step, generic/host continuation, direct-host
    checkpoint, and replay verification paths.
13. Admission uses append-only visits and existing receipt/evidence indexes. It does not
    use `previousState`, observability, memory, a new state path, or a schema migration.

## Verification

- [ ] Playbook is registered; active worker phases, guidance, optional tool subsets, repair
      routes, canonical registration digest, and completion contract validate.
- [ ] Subset-absent phases activate exact YAML; any present subset is one non-empty,
      duplicate-free strict YAML subset copied into invocation metadata and passed exactly to Pi.
- [ ] Empty/duplicate/equality-sized/non-YAML or task/trust/runtime-selected declarations fail
      before session creation; active removal/addition/replacement fails before the model prompt,
      and host-private tools remain separate.
- [ ] Start/step/respond/recover/cancel all fail closed on wrong identity.
- [ ] Missing/corrupt input IDs are rejected before worker use; cross-run fan-in succeeds.
- [ ] Crash and partial-fan recovery preserve exact refs.
- [ ] Gate payload/challenge binds the response.
- [ ] Positive terminals satisfy closed `CompletionGate` v2 origin, visit, product,
      receipt-predicate, and unresolved-policy checks.
- [ ] A failed positive is durable `incomplete/met:false`, preserving its artifacts and
      refusal codes; negative terminals remain reachable from arbitrary states.
- [ ] `status`/`recover` verify post-v2 envelopes and exact legacy positives remain replayable.

## Files

- `apps/orchestration/src/service.ts`
- `apps/orchestration/src/engine.ts`
- `apps/orchestration/src/playbooks/playbook.ts`
- `apps/orchestration/src/playbooks/registry.ts`
- `apps/orchestration/src/checkpointer.ts`
- `apps/orchestration/src/artifact-store.ts`
