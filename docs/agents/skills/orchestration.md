# Skill Orchestration — TypeScript engine and exact artifacts

## Architecture

Every workflow skill is a registered TypeScript playbook. The playbook owns states,
result contracts, input selection, routing, repairs, gates, fan-out, and terminal truth.
The shared engine owns request validation, authority, checkpoints, artifacts, receipts,
budgets, recovery, and observability. Skill directories contain no executable runtime.

## Protocol

1. Closed requests: `start`, `step`, `status`, `recover`, `respond`, `cancel`.
2. Persist control state in the Node SQLite checkpointer keyed by exact `run_id`.
3. Every cognitive directive carries exact input IDs/refs and output metadata.
4. Preflight every input by direct manifest lookup and exact-byte verification; cross-run fan-in is valid.
5. Persist and re-read complete finalized worker bytes before routing fields can advance.
6. Keep payload bytes out of `RunContext`; retain exact selected refs.
7. Use branch IDs—not completion order—for fan-in and partial recovery.
8. Workers and skill drivers receive no workflow-memory transport.
9. Evaluate the playbook’s completion gate before admitting a positive terminal.

## Directives

| Action                    | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `invoke_agent`            | One worker assignment with exact inputs and output contract  |
| `invoke_agents_parallel`  | Bounded branch assignments with independent output contracts |
| `await_user`              | Persisted human/clarification gate                           |
| `paused`                  | Retriable owner dispatch stop; checkpoint unchanged          |
| `complete` / `incomplete` | Honest terminal truth plus selected product ref              |
| `cancelled` / `error`     | Typed negative terminal                                      |
| `status`                  | Safe persisted-state projection                              |

## Composition

- Single and parallel modes create TypeScript runs directly.
- Chain mode verifies and forwards the prior terminal ID directly across runs.
- `{previous}` names that exact ID; it never carries predecessor payload text.
- Chain steps may add explicit multi-source IDs; resume reuses checkpointed refs.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE=paused` blocks new dispatch before selected refs or
pending state can change. `active` recovery reissues the exact pending directive or next
compatible revision. Compaction reads caller-supplied run IDs from the TypeScript v2
database; it never scans sessions or semantic memory.

## Safety

- Reissued states must be idempotent or split prepare/apply.
- Repairs are bounded and must report honest exhaustion.
- Verifiers require captured evidence where the contract declares it.
- Model diversity is supplementary review, not independent proof.
- Worker context/tool boundaries are not an OS sandbox.

## Verification

- [ ] Playbook is registered and its contract validates.
- [ ] Wrong-run, wrong-state, stale, and malformed refs fail closed.
- [ ] Owner capture and receipt verification precede routing.
- [ ] Single, parallel, chain, resume, clarification, and crash recovery are covered.
- [ ] Compaction reconstructs TypeScript run/artifact refs by exact ID.
- [ ] Payload bytes and durable memory never enter checkpoint control state.
- [ ] Flow descriptor and `resources/flow.html` agree exactly.

## Files

| File                                       | Purpose                          |
| ------------------------------------------ | -------------------------------- |
| `apps/orchestration/src/engine.ts`         | Shared protocol and admission    |
| `apps/orchestration/src/service.ts`        | In-process host                  |
| `apps/orchestration/src/checkpointer.ts`   | Durable state                    |
| `apps/orchestration/src/artifact-store.ts` | Immutable artifact owner         |
| `apps/orchestration/src/playbooks/*.ts`    | Registered playbooks             |
| `.pi/extensions/skill/README.md`           | Skill composition and invocation |
