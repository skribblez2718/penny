# State Machine Reference — TypeScript playbooks

## What

A Penny workflow is a TypeScript playbook behind `PlaybookCore`. The playbook uses
explicit state IDs and successor tables; the shared engine owns requests, checkpoints,
workers, receipts, gates, recovery, and terminals.

## Core interface

A playbook implements initialization, dispatch, resume/cancel behavior, accepted-result
bookkeeping/routing, and pending-directive rebind. State-specific result validation belongs
to the active registration, not `PlaybookCore`. Optional capabilities add fan aggregation,
routing-only malformed repair, liveness terminalization, typed repair classification, and
host-plane policies. The engine probes capabilities structurally, never by playbook name.

## Rules

1. Use domain-named states and one canonical state→agent table.
2. Keep business/product bytes out of the machine; checkpoint compact fields and refs.
3. Put happy successors in playbook tables and typed repair targets/budgets in the registration contract.
4. Make host/deterministic states idempotent or split prepare from apply. Research `sealing_core` and `rendering` use existing selected refs/events, stable operation identity, immutable artifacts, and adopt-or-verify filesystem writes; they add no durable-state field or table.
5. Apply actual operator policy to repairs without inventing a finite cap; exhaustion is an honest negative or unresolved result. Derive values from actual operator policy, not test constants or model guesses.
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

A verifier failure returns `EvaluationResult`: a feedback kind, bounded detail/findings,
and a non-empty strategy delta. It cannot carry `target_state` or `exhausted`. The engine
resolves the unique `origin_state + feedback_kind` route from `repair_routing`, applies
any actual operator-supplied iteration limit and reservation, guards engine-owned control fields during
optional domain bookkeeping, and performs the transition. Exhaustion follows the registered
honest successor. The checkpoint event stores only detail/strategy SHA-256 digests and budget
metadata—never findings or product bodies. Structural malformed results remain on the separate
P1.2 routing-repair/liveness path.

## Recovery

The checkpointer stores the pending directive and selected refs under exact `run_id`. A host-only
state may intentionally have no worker directive; the engine resumes its registered deterministic
host continuation from selected refs and append-only events before exposing another worker/terminal.
`recover` rebinds output revision metadata when necessary and reissues pending work.
Existing runs never change owner or database. Compaction reads schema-v2 `RunContext` rows in the
catalog-bound unversioned database by supplied run ID. Historical positives without an admission envelope replay exactly as legacy truth;
new positives require an envelope, and envelope corruption fails closed on replay.

## Durable child-workflow call state

The child-call storage boundary stores one compact canonical `ChildWorkflowCallRecordV2` for new
calls, while retaining exact V1 replay, in the project orchestration control store. It binds the
deterministic call ID to the exact parent
run/state/visit,
deterministic ordinary child run, pending directive, request/input/output-contract refs and
digests, registration digests, project/policy binding, active lease binding, and current lifecycle.
Historical V1 records additionally retain their original allocation for exact replay.

Reservation is artifact-first and control-store-second. `ChildWorkflowStateOwner` mints an opaque
custody capability only from a concrete `ArtifactStore`; the checkpointer confirms that
store's project binding matches its own and verifies the canonical request plus every bound input
by manifest ref and immutable bytes. One `BEGIN IMMEDIATE` transaction records the parent's exact
pending child directive, creates the ordinary unstarted child run and initial event, inserts the
call row, and records the parent reservation event. `(parent_run_id, parent_state_id, call_key)` is
unique. Exact retries adopt the existing record, including its current lifecycle; changed immutable
operands conflict. Artifact-only state, an unpaired child run, or missing/mismatched linkage fails
closed. Recovery never synthesizes a run, ref, registration, visit coordinate, or call row.

The lifecycle vocabulary is `reserved | running | waiting_user | paused | terminal_recorded |
failed | cancelled | consumed`. Storage compare-and-set remains separate from dispatch. The active
runtime owner moves a reserved call to running, executes the ordinary child engine, captures a
verified terminal, and atomically consumes it with the parent continuation. A normal service
constructs this owner; a host can explicitly disable it. A runner cancellation signal or concurrent
durable parent-cancel request transitions the call to `cancelled` before/while the parent is
terminal and cannot resume a parent from a late boundary. Inactivity expiry terminates and consumes
the child result without falsely treating it as a parent-cancel request. Version-2 parent-owned
child gates, exact mediated replies, and waiting/captured-terminal recovery preserve frozen bindings;
arbitrary missing linkage is never reconstructed. Parent/provider authority remains digest-bound;
qualification/discovery is separate and Gate 2 remains `not_run`. See the
[engine feature-status table](../orchestration/overview.md#child-workflow-feature-status).

Terminal-run pruning holds linked control/gate/receipt/session cohorts while live, retained, or
custody-blocked, including unconsumed/quarantined host effects. A cancelled parent's abandoned child
needs an exact durable terminal and no unsettled host work before eligibility. Eligible controls
are deleted parent-first atomically; safe session cleanup follows and immutable artifacts remain.
Schema v13 is created through explicit provisioning; an active retained
v10/v11/v12 database is upgraded only by the backup-first `penny-state upgrade` path. The supported steps
share one exclusive transaction and add no synthetic rows. The v11→v12 step preserves canonical V1 record
bytes while admitting V2; v12→v13 adds the host-operation journal empty. Retained-call upgrade requires artifact manifest/object units and verifies
their refs; unsupported, unversioned, newer, malformed, or ambiguously bound state refuses. Ordinary
runtime and repeated `init` remain non-mutating.

The active V2 policy/call contract removes predicted per-child turns, tool calls, external calls,
output bytes, steps, elapsed time, aggregate capacity, and parent reserve. A child instead uses its
registered playbook repair/liveness policy and any operator-supplied service-wide step limit. The call binds an exact
content-free inactivity lease and fence `(owner epoch, attempt, session, token)`. The owner feeds it
only monotonic host-observed non-empty worker activity or workflow convergence, renewing one interval
at a time. Activity never advances the convergence epoch; stale/replayed fences and signals refuse;
lease expiry aborts the child. Existing V1 rows retain their original fixed allocations for exact
legacy replay and are never minted for new calls.

## Verification

- [ ] State vocabulary and state/agent binding are exact-set pinned.
- [ ] Every edge has a named trigger and repair controls and any operator-supplied limits are identified.
- [ ] Result schemas are closed and state-specific.
- [ ] Gate and terminal routes are independently tested.
- [ ] Recovery and cancellation preserve honest terminal truth.

Reference: `apps/orchestration/src/playbooks/research.ts` and
`apps/orchestration/src/playbooks/knowledge-base.ts`.
