# Common TypeScript Playbook Patterns

Penny has one workflow runtime: `@penny/orchestration`. Skills register TypeScript
playbooks and carry no executable delegate.

## Sequential pipeline

Use explicit state IDs and a successor table when each phase has one clear predecessor.
The engine checkpoints every accepted phase result and supplies the next worker only the
selected exact refs.

## Policy-led repair

Derive values from actual operator policy, not test constants or model guesses. An unspecified limit is not a finite default; productive work continues under cancellation, progress/inactivity and measured-error controls.

Verifier failures return a typed cause and strategy delta, not a target. The engine selects
the unique registered origin/cause route, applies any actual operator-supplied limit, and re-enters verification.
Budget exhaustion follows the registered honest successor. Checkpoint evidence contains only
route hashes and counters, not findings or product bodies.

## Human gate

Emit `await_user` immediately before expensive, external, or irreversible work. Bind the
response to the exact gate challenge. Approve advances; refine returns to the deciding or
authoring state; deny terminates safely.

## Parallel fan

Use branch IDs for independent workers. Each branch has its own output contract. Fan-in
is keyed by branch identity, so restart can preserve accepted siblings and reissue only
missing work.

## Deterministic host state

Use a host state for objective checks or owner-only I/O. It must be idempotent because
recovery may reissue it. Split prepare/verify/apply around a gate for consequential work.

## Skill chain

The chain owner verifies and forwards the exact terminal artifact ID into the next run’s
`chain_input` binding. `{previous}` identifies that direct exact-ID handoff rather than carrying
inline predecessor text. Chain checkpoints preserve exact refs across restart.

## Child reservation and active depth-one dispatch

Penny has a durable storage seam for registered parent/child calls, separate from runtime dispatch. It verifies the canonical
request and inputs in a concrete artifact store bound to the same project as the checkpointer. One
transaction suspends the parent on its exact pending directive, creates an ordinary unstarted child
run, and records both the call and initial events. Repeating the same immutable call adopts the
existing lifecycle; changing an operand conflicts, and missing linkage is never guessed from
artifacts, memory, logs, or prose.

An ordinary service constructs the child owner by default, making an authorized depth-one child
call executable; a host can explicitly disable it. The owner runs the reserved child through the
same engine/runner, validates the terminal core, and atomically continues the parent exactly once.
It enforces fixed project/call admission, uses the child's registered repair/liveness policy and
operator-supplied service step limit, if present instead of a guessed per-call resource allocation, and applies a
content-free inactivity lease plus runner/parent cancellation forwarding. Parent-mediated child
gates/replies, waiting/captured-terminal recovery and linked control/gate/receipt/session retention
are implemented under frozen bindings and cancellation/selection fences. Immutable artifact bytes
are preserved. Provider promotion/live qualification remain separate; Gate 2 stays `not_run`.
See [current status](state-management.md#current-child-workflow-status).

## Testing

Tests drive closed requests through the real TypeScript engine using temporary Node SQLite
and artifact roots. They mock model results, not state transitions, and cover gates,
repairs, exhaustion, cancellation, recovery, and composition.

See:

- `docs/agents/state-management/state-machine-reference.md`
- `docs/agents/state-management/orchestration-integration.md`
- `apps/orchestration/src/playbooks/research.ts`
- `apps/orchestration/src/playbooks/knowledge-base.ts`
