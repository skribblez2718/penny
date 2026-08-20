# Common TypeScript Playbook Patterns

Penny has one workflow runtime: `@penny/orchestration`. Skills register TypeScript
playbooks and carry no executable delegate.

## Sequential pipeline

Use explicit state IDs and a successor table when each phase has one clear predecessor.
The engine checkpoints every accepted phase result and grants the next worker only the
selected exact refs.

## Bounded repair

Verifier failures identify an actionable producer state. Repairs consume a finite budget,
change strategy, and re-enter verification. Budget exhaustion produces an honest negative
or unresolved result.

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

The chain owner persists exact terminal bytes into the next run’s `chain_input` artifact.
`{previous}` identifies that grant rather than carrying inline predecessor text. Chain
checkpoints preserve exact refs across restart.

## Testing

Tests drive closed requests through the real TypeScript engine using temporary Node SQLite
and artifact roots. They mock model results, not state transitions, and cover gates,
repairs, exhaustion, cancellation, recovery, and composition.

See:

- `docs/agents/state-management/state-machine-reference.md`
- `docs/agents/state-management/orchestration-integration.md`
- `apps/orchestration/src/playbooks/research.ts`
- `apps/orchestration/src/playbooks/knowledge-base.ts`
