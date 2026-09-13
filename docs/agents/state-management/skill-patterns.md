# Skill Patterns — TypeScript workflow shapes

## Rules

- Choose the simplest topology that fits the proven workflow.
- One cognitive state maps to one agent or one bounded branch fan.
- State transitions depend on typed results, not inferred prose.
- Repairs return to the producer able to fix the defect.
- Gates sit at reversibility cliffs.
- Exhaustion is honest; cancellation and denial never become success.
- Deterministic host states are idempotent and authority-bounded.

## Sequential pipeline

Use a successor table for `gather → synthesize → verify → produce`. Each state reads
only exact selected predecessors; the terminal result exposes the selected product ref.

## Bounded repair

A verifier classifies the gap as a closed `EvaluationResultV2` feedback kind and supplies a
non-empty strategy delta; it cannot name a target or claim exhaustion. The engine resolves the
unique host-registered origin-state/feedback-kind route, charges its finite budget, and performs
the transition. Repeated gaps escalate or exhaust through the registered successor instead of
spinning.

## Planned human gate

The playbook emits `await_user` with an exact challenge and bounded questions. `respond`
accepts only the matching gate/challenge. Approve advances, refine returns to the author,
and deny terminates safely.

## Parallel fan

The directive carries one branch ID, task, owner-selected exact input IDs, and output
contract per branch. The worker layer enforces concurrency; fan-in uses branch IDs and
preserves accepted siblings during recovery.

## Deterministic host state

Use for checks or owner-only I/O that need no model. Make it safe to reissue. Consequential
operations use prepare → gate → verify current preimage → apply, never an agent-authored
approval.

## Skill composition

Parallel skills are independent TypeScript runs. Chains persist exact terminal bytes as
direct cross-run terminal IDs plus optional explicit fan-in. Chain resume reconstructs the failed step from its durable
checkpoint and never substitutes payload text into `{previous}`.

## Child reservation and active depth-one dispatch

Use the current child-call owner only when implementing the durable storage seam. Persist the
canonical request and inputs in one concrete project-bound artifact store first. Then reserve the
exact parent visit/call key, parent pending directive, ordinary unstarted child run, initial events,
and canonical call row in one control-store transaction. A repeated exact call adopts the existing
record and lifecycle; changed operands or incomplete/mismatched linkage conflict. Never reconstruct
a call from artifacts, memory, logs, prose, or search.

A normal service constructs the depth-one child owner; a host may explicitly disable it. The owner
runs the reserved child through the ordinary engine/runner, validates its terminal, persists a
child-result artifact, and atomically consumes it into the parent. New calls carry no predicted
turn/tool/external/output/step/time allocation, aggregate capacity, or parent reserve. The child uses
its registered repair/liveness policy and the service-wide step backstop, plus a digest-bound
content-free inactivity lease renewed from fenced host-observed worker activity or workflow
convergence. The owner also enforces fixed call/active/project admission, lease expiry, and
runner-signal/concurrent durable parent-cancel propagation. It does not yet cover child gates,
arbitrary post-capture restart
reconciliation, cohort artifact/receipt/session retention, promotion, or live qualification. Gate 2
remains `not_run`; active runtime execution does not fabricate qualification evidence.

## Testing

Drive real `OrchestrationEngine` requests against temporary Node SQLite and artifact
roots. Use deterministic `ModelClient` fixtures, assert directives and selected refs, and
cover every gate/repair/terminal/recovery route.

Reference implementations:

- `apps/orchestration/src/playbooks/research.ts`
- `apps/orchestration/src/playbooks/knowledge-base.ts`
- `apps/orchestration/tests/core-runtime.test.ts`
- `apps/orchestration/tests/kb-playbook.test.ts`
