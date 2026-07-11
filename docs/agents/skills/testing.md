# Skill Testing — Test requirements for playbooks

## What

Every skill's `BasePlaybook` subclass is tested in `apps/orchestration/tests/`. Tests drive the playbook step by step against a temporary checkpointer, feeding pre-built SUMMARY dicts and asserting the resulting state transitions, gates, loops, and terminal outcomes.

## Why

A playbook is a state machine with multiple agents and mempalace interactions. Without step-by-step coverage of its routing, gates, retry loop, and escalation, regressions are invisible until runtime failures.

## Rules

1. **Test against a tmp checkpointer.** Construct a `Checkpointer(db_path=tmp_path / "orch.db")` (pytest `tmp_path` fixture) so state persists across steps but is thrown away after the test.
2. **Fresh playbook instance per step.** Each `start`/`step` builds a NEW playbook instance pointed at the same checkpointer — this mirrors the subprocess-per-invocation reality and exercises the `run_id`/checkpointer contract. Do **not** reuse one in-memory instance across steps.
3. **Feed pre-built SUMMARY dicts to `step`.** `step(session_id=..., run_id=..., agent=..., result={...})`. Mock agent *results*, not agent processes.
4. **Assert on the returned directive.** Check `action` (`invoke_agent`, `escalate_to_user`, `complete`, `error`), `state_id`, and result fields.
5. **Cover every branch.** Happy path to `complete`; each gate (approve / refine / deny); the retry loop back-edge; budget exhaustion → `complete` with `met=False`; contract violations that re-issue a step; escalation to `awaiting_clarification`; and crash-resume via `recover_pending`.
6. **Run with pytest.** `python3 -m pytest apps/orchestration/tests/ -v`

## Test Pattern

```python
from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.<name> import <Name>Playbook

@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")

def _start(cp):
    return <Name>Playbook(cp).start(session_id=SID, run_id=RID, goal=..., constraints=...)

def _step(cp, agent, result):
    # FRESH instance, same checkpointer
    return <Name>Playbook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)
```

See `apps/orchestration/tests/test_code_playbook.py` for the reference: gate pause/resume, the Ralph-Wiggum retry loop, budget exhaustion, contract-violation re-issue, and `recover_pending` re-presenting a pending gate. `test_learn_playbook.py` adds the per-unit self-loop and verify⇄fix patterns.

## Harness Facts (each cost a debugging round when guessed wrong)

- **Run with the project venv.** `../../.venv/bin/python -m pytest tests/ -v` from `apps/orchestration/` — the `orchestration` package is installed in the venv; the system python raises `ModuleNotFoundError`.
- **Gate/clarification resume agent is `"user"`** — `_step(cp, "user", {"user_response": "approve"})`. Not `__user__`.
- **Parallel fan-in agent is `"__parallel__"`** with a batch list: `[{"branch_id": ..., "agent": ..., "exitCode": 0, "summary": {...}}, ...]` — all branches fed in ONE step.
- **`Checkpointer.load(run_id)` returns a `CheckpointRecord`** — assert on attributes (`rec.status`, `rec.current_state_id`), not subscripts.
- **`start()` precondition failures surface as an `error` directive**, not an exception — assert `d["action"] == "error"` and inspect `d["errors"]`; `pytest.raises` will not fire.
- **`is_stalled(window=2)` needs two RECORDED iterations with identical gaps** before it trips — a stall-escalation test needs three failing rounds (fail→fix, fail→fix, fail→escalate), and `progress_check` runs before `route_after`'s exhaustion branch, so stall wins over exhaustion on the same step.

## Constraints

- **Full-path coverage is mandatory.** Stubs and placeholders are not acceptable; every terminal outcome and every gate branch must be asserted.
- **Do not test a state-serialization round-trip.** There is no `extract_state`/`restore_state`; persistence is the engine checkpointer's concern (covered by engine tests), not each playbook's.
- **Mock agent results, not agent processes.**

## Verification

- [ ] Every state transition and gate branch is asserted
- [ ] Retry loop, budget exhaustion (`met=False`), and escalation are covered
- [ ] Crash-resume via `recover_pending` is covered
- [ ] All tests pass: `python3 -m pytest apps/orchestration/tests/ -v`

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/resilience.md` | Crash-resume and error handling |
