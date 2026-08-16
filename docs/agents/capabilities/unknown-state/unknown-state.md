# unknown-state — the engine's UNCERTAIN/stall escalation seam

## What

Every Penny skill rides the shared orchestration engine (`apps/orchestration/`). When an agent cannot proceed, the engine pauses the run at `unknown -> awaiting_clarification`, surfaces one free-text question to the user, and resumes the SAME run once the user answers. This is a cross-cutting engine capability — not a per-skill concern. There is no `UNKNOWN_STATE` FSM in any `orchestrate.py`; `.pi/skills/<skill>/scripts/orchestrate.py` is a ~5-line delegate to `orchestration.cli`.

## Why

Agents hit blockers: missing information, ambiguous requirements, contradictory constraints, or a retry loop that is spinning without progress. Escalation is a structured pause-and-resume instead of guessing, fabricating a summary, or failing silently.

## Two triggers (both in `BasePlaybook.step`)

1. **UNCERTAIN confidence.** After a SUMMARY passes the engine's contract gatekeeper, if `confidence == "UNCERTAIN"` (the weakest rung of `CERTAIN | PROBABLE | POSSIBLE | UNCERTAIN`) AND the current state is in the playbook's `ESCALATABLE_STATES`, the engine escalates. UNCERTAIN on a non-escalatable state does not.
2. **Progress-assessment gate (loop-research Recs 1 & 2) — default-on.** `progress_check(state, ctx, summary)` runs after the UNCERTAIN check, before routing. If it returns a reason string — a retry whose `strategy_change` repeats a prior approach (`strategy_repeated`), or N iterations with the same unresolved gaps (`is_stalled`) — and the state is escalatable, the engine escalates with that reason as the `unknown_reason`. The BASE `progress_check` now enforces both checks for every playbook (the engine auto-records iteration digests to feed them); a playbook opts out with `LOOP_GUARDS = False` or replaces the hook with its own domain version. This bounds a spinning loop instead of burning the remaining `ctx.max_iterations` budget.

For a parallel fan-out state, the aggregated confidence is the **weakest** branch; UNCERTAIN there escalates on the weakest branch's spec.

## States and events

Machine states (playbook-owned names, but these two are contract-required): `unknown` and `awaiting_clarification`. Standard events: `to_unknown`, `escalate`, `clarify`, `abort`.

- `_escalate` sets `ctx.previous_state = state`, `ctx.last_confidence = UNCERTAIN`, and `ctx.unknown_reason` (from the summary's `unknown_reason`, the `progress_check` reason, or a generated default). It fires `to_unknown` then `escalate`.
- **Guardrail:** if the machine does not actually land on `awaiting_clarification` (e.g. `ESCALATABLE_STATES` is not a subset of the machine's `to_unknown`/`escalate` sources), the engine routes to terminal `error` rather than persisting a wedged `awaiting_user` at the wrong state.
- On success it persists `STATUS_AWAITING_USER` at `awaiting_clarification` and emits an `escalate_to_user` directive carrying `questions`, `previous_state`, `unknown_reason`, `session_id`, `run_id`. The question is a single free-text `clarify` prompt (`allowOther: true`) — the engine does not offer a fixed retry/skip/restart menu.

## Resume

The TS driver resumes by feeding a `user` step keyed by `run_id` (the user's text arrives as the step `result`; the driver passes it via `constraints.user_response`). `BasePlaybook.step` rehydrates ctx + state from the checkpointer, sees `agent == "user"`, and calls `_resume`:

1. Rejects the resume unless the run is at `awaiting_clarification` (a planned `GATE_STATES` pause is a different path, handled by `_resume_gate` / `route_user`).
2. Stores the answer in `ctx.clarification_text`.
3. Fires the `clarify` event. The machine transitions to the producer state that can act on the answer. The research playbook resumes at `researching` or `synthesizing` when the blocker identifies one of those producers, with `planning` as the fallback.
4. `_advance_to` re-issues that state. `ctx.clarification_text` is appended to the next agent's task message so the answer actually informs the retry.

There is no `restart`/`skip`/`retry` tri-choice, no `orchestrator_state` blob on the wire, and no `previous_state` payload threaded back — `previous_state` lives in `ctx` and is checkpointed.

## Persistence & resilience

- `unknown_reason`, `previous_state`, `last_confidence`, and `clarification_text` all live in `ctx` and are checkpointed against `run_id` in the durable SQLite checkpointer. No `/tmp/<skill>-<session_id>.json`, no `--state`/`--state-data` argv, no `extract_state`/`restore_state`.
- Crash-resume is automatic: the engine's recovery scan re-presents a pending question via `escalation_directive` / `pending_user_directive` for a run left `STATUS_AWAITING_USER`.
- Summary validation is the engine's job (`validate_summary_contract`); a malformed SUMMARY is retried (bounded) and never advances the run on a fabricated default.

## Declaring escalatability (per playbook)

A playbook opts a state in by listing it in `ESCALATABLE_STATES` and giving its machine a `to_unknown` edge from each listed state plus the `escalate` and `clarify` edges. The current research playbook lists its planning, critique, research, synthesis, and validation producers; its conditional `clarify` edges resume the producer that can use the answer, with planning as the conservative fallback.

```python
ESCALATABLE_STATES = frozenset({
    "planning", "critiquing_plan", "researching",
    "synthesizing", "critiquing_report", "validating",
})
```

## Verification

- [ ] UNCERTAIN on an escalatable state pauses at `awaiting_clarification`; on a non-escalatable state it does not.
- [ ] A stalled / strategy-repeating loop escalates via `progress_check` before budget is exhausted.
- [ ] Misconfigured `ESCALATABLE_STATES` (no reachable `awaiting_clarification`) routes to `error`, not a wedge.
- [ ] A `user` step keyed by `run_id` sets `clarification_text`, fires `clarify`, and re-issues the target state.
- [ ] `unknown_reason` / `previous_state` / `clarification_text` survive crash-resume via the checkpointer.

## Files

| File                                                                                           | Purpose                                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/orchestration/src/orchestration/engine.py`                                               | `_escalate`, `_resume`, `progress_check`, escalation guardrail, `escalation_directive` |
| `apps/orchestration/src/orchestration/contracts.py`                                            | `Confidence` taxonomy, `escalate_to_user` directive builder                            |
| `apps/orchestration/src/orchestration/playbooks/research.py`                                   | Current `ESCALATABLE_STATES`, progress checks, and conditional clarification resume    |
| `apps/orchestration/tests/test_engine.py`, `test_engine_seams.py`, `test_research_playbook.py` | Escalation and resume tests                                                            |
