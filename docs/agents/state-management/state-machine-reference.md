# State Machine Reference — TypeScript playbooks

## What

A Penny workflow is a TypeScript playbook behind `PlaybookCoreV1`. The playbook uses
explicit state IDs and successor tables; the shared engine owns requests, checkpoints,
workers, receipts, gates, recovery, and terminals.

## Core interface

A playbook implements initialization, dispatch, resume/cancel behavior, accepted-result
bookkeeping/routing, and pending-directive rebind. State-specific result validation belongs
to the active registration, not `PlaybookCoreV1`. Optional capabilities add fan aggregation,
routing-only malformed repair, liveness terminalization, typed repair classification, and
host-plane policies. The engine probes capabilities structurally, never by playbook name.

## Rules

1. Use domain-named states and one canonical state→agent table.
2. Keep business/product bytes out of the machine; checkpoint compact fields and refs.
3. Put happy successors in playbook tables and typed repair targets/budgets in the registration contract.
4. Make host/deterministic states idempotent or split prepare from apply. Research `sealing_core` and `rendering` use existing selected refs/events, stable operation identity, immutable artifacts, and adopt-or-verify filesystem writes; they add no durable-state field or table.
5. Bound every repair; exhaustion is an honest negative or unresolved result.
6. Use `await_user` for planned gates and blocking clarification.
7. Export a `*_FLOW` descriptor and drift-test it against `resources/flow.html`.
8. Declare positive-terminal origins, required visits, latest product, host receipt predicates,
   and unresolved policy through the closed `CompletionGate` v2. Predicate IDs must be
   registered by the host; model output cannot select them.
9. Register construction through `playbooks/registry.ts`; unknown names fail closed.

## State data

`RunContext` contains immutable identity, current/previous state, budgets, compact
playbook data, selected artifacts, pending branches/directive, and terminal directive.
It serializes to schema-v2 JSON in Node SQLite. Exact artifact bodies never enter it.
State-transition visits are additionally journaled into existing append-only checkpoint events;
terminal origin and required history are resolved only from that ledger, never `previousState`.

## Typical routing

```ts
const NEXT_STATE = {
  gathering: "synthesizing",
  synthesizing: "verifying",
  verifying: "complete",
} as const;
```

A verifier failure returns `EvaluationResultV2`: a feedback kind, bounded detail/findings,
and a non-empty strategy delta. It cannot carry `target_state` or `exhausted`. The engine
resolves the unique `origin_state + feedback_kind` route from `repair_routing`, applies
`used + 1 <= max_iterations - reserved_attempts`, guards engine-owned control fields during
optional domain bookkeeping, and performs the transition. Exhaustion follows the registered
honest successor. The checkpoint event stores only detail/strategy SHA-256 digests and budget
metadata—never findings or product bodies. Structural malformed results remain on the separate
P1.2 routing-repair/liveness path.

## Recovery

The checkpointer stores the pending directive and selected refs under exact `run_id`. A host-only
state may intentionally have no worker directive; the engine resumes its registered deterministic
host continuation from selected refs and append-only events before exposing another worker/terminal.
`recover` rebinds output revision metadata when necessary and reissues pending work.
Existing runs never change owner or database. Compaction reads exact v2 rows by supplied
run ID. Historical positives without an admission envelope replay exactly as legacy truth;
new positives require an envelope, and envelope corruption fails closed on replay.

## Verification

- [ ] State vocabulary and state/agent binding are exact-set pinned.
- [ ] Every edge has a named trigger and bounded repairs are identified.
- [ ] Result schemas are closed and state-specific.
- [ ] Gate and terminal routes are independently tested.
- [ ] Recovery and cancellation preserve honest terminal truth.

Reference: `apps/orchestration/src/playbooks/research.ts` and
`apps/orchestration/src/playbooks/knowledge-base.ts`.
