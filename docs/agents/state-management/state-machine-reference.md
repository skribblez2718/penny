# State Machine Reference — TypeScript playbooks

## What

A Penny workflow is a TypeScript playbook behind `PlaybookCoreV1`. The playbook uses
explicit state IDs and successor tables; the shared engine owns requests, checkpoints,
workers, receipts, gates, recovery, and terminals.

## Core interface

A playbook implements initialization, dispatch, resume/cancel behavior, state-specific
result validation, accepted-result routing, and pending-directive rebind. Optional
capabilities add fan aggregation, malformed-result reissue, and typed gap classification.
The engine probes capabilities structurally, never by playbook name.

## Rules

1. Use domain-named states and one canonical state→agent table.
2. Keep business/product bytes out of the machine; checkpoint compact fields and refs.
3. Put routing in explicit successor/repair tables and playbook methods.
4. Make host/deterministic states idempotent or split prepare from apply.
5. Bound every repair; exhaustion is an honest negative or unresolved result.
6. Use `await_user` for planned gates and blocking clarification.
7. Export a `*_FLOW` descriptor and drift-test it against `resources/flow.html`.
8. Declare terminal requirements through `CompletionGateV1`.
9. Register construction through `playbooks/registry.ts`; unknown names fail closed.

## State data

`RunContext` contains immutable identity, current/previous state, budgets, compact
playbook data, selected artifacts, pending branches/directive, and terminal directive.
It serializes to schema-v2 JSON in Node SQLite. Exact artifact bodies never enter it.

## Typical routing

```ts
const NEXT_STATE = {
  gathering: "synthesizing",
  synthesizing: "verifying",
  verifying: "complete",
} as const;
```

A verifier failure returns a typed `EvaluationResultV1` whose `target_state` identifies
the repair producer. The engine routes that typed cause under the playbook’s budget;
it does not infer repairs from prose.

## Recovery

The checkpointer stores the pending directive and selected refs under exact `run_id`.
`recover` rebinds output revision metadata when necessary and reissues pending work.
Existing runs never change owner or database. Compaction reads exact v2 rows by supplied
run ID.

## Verification

- [ ] State vocabulary and state/agent binding are exact-set pinned.
- [ ] Every edge has a named trigger and bounded repairs are identified.
- [ ] Result schemas are closed and state-specific.
- [ ] Gate and terminal routes are independently tested.
- [ ] Recovery and cancellation preserve honest terminal truth.

Reference: `apps/orchestration/src/playbooks/research.ts` and
`apps/orchestration/src/playbooks/knowledge-base.ts`.
