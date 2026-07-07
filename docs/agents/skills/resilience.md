# Skill Resilience — Error handling and recovery on the engine

## What

Skills run on the shared orchestration engine. State survives crashes via the engine's **durable SQLite checkpointer keyed by `run_id`** — not a hand-written session file. A playbook's job is to validate agent SUMMARYs, route safely, and never fabricate completion; crash-resume itself is the engine's responsibility.

## Why

Skills run in subprocesses (one per `start`/`step` invocation) with no interactive user. The engine persists a checkpoint after each step, so an interrupted run automatically re-issues its last step on the next `step`/`recover` — no state is lost and no completion is faked. A playbook only has to make each step **safe to re-run** and honest about what happened.

## Rules

1. **State is checkpointed by the engine.** Every step is persisted against `run_id`. There is no `/tmp/<skill>-<session_id>.json` to write and no `extract_state`/`restore_state` round-trip to maintain.
2. **Crash-resume is automatic.** An interrupted run re-issues its pending step via `recover_pending` / the `recover` CLI. Design each state's work to be idempotent so a re-issued step is harmless.
3. **Validate agent SUMMARY before routing.** In `route_after`, reject empty, malformed, or missing SUMMARY fields; a contract violation should re-issue the same step (bounded by `ctx.max_iterations`), not advance on bad data.
4. **Use safe defaults that never claim completion.** Treat a missing/invalid field as `complete: false`, `passed: false`, `count: 0` — never as success.
5. **Report loop exhaustion honestly.** When a retry loop hits `ctx.max_iterations`, emit `complete` with `met=False` (record the miss); never fabricate success.
6. **Escalate a spinning loop.** A stalled retry or a repeated failed strategy (caught by `progress_check` in an `ESCALATABLE_STATES` state) pauses the run at `awaiting_clarification` rather than burning the whole budget.

## Error / recovery behavior

| Situation | Behavior |
|-----------|----------|
| Agent SUMMARY malformed / missing required field | Contract violation → re-issue the same step (bounded by `max_iterations`) |
| Agent returns `confidence: UNCERTAIN` | Escalate → pause at `awaiting_clarification`; user answer resumes via `step --agent user` |
| Parallel branch failure | Aggregate per `PARALLEL_BY_STATE`; proceed if the state's contract is met, else re-issue/escalate |
| Process crash mid-step | Engine re-issues the pending step from the last checkpoint on `recover` |
| Retry budget exhausted | `complete` with `met=False` — honest miss, never faked success |
| Planned gate denied | Route to the playbook's terminal `error` state |

## Constraints

- **Never fake completion.** No error or exhaustion path may report success.
- **The checkpointer is the source of truth for run state** — not mempalace, not a temp file. Agents' working notes go to mempalace; run state lives in the checkpointer keyed by `run_id`.
- **Make steps idempotent.** A re-issued step must not double-apply side effects.

## Verification

- [ ] Contract violations re-issue the step instead of advancing on bad data
- [ ] Loop exhaustion emits `complete` with `met=False`
- [ ] UNCERTAIN / stalled loops escalate to `awaiting_clarification`
- [ ] A killed run resumes correctly via `recover` (covered by a playbook test)

## Related Documents

- [Loops](loops.md) — Agentic loop taxonomy, termination controls, failure modes, and verifier design
- [Orchestration](orchestration.md) — Engine-backed skill protocol
- [Skill Standard](skill-standard.md) — Full skill standard
- [Testing](testing.md) — Playbook test requirements
