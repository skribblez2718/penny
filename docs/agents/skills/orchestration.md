# Skill Orchestration — Engine-backed state machine protocol


## What

An engine-backed skill's `orchestrate.py` is a **thin (~5-line) delegate** to the shared `orchestration` package — but the skill's real state machine is a concrete **`BasePlaybook` subclass** in `apps/orchestration/src/orchestration/playbooks/<skill>.py`. That subclass owns *what* (its own domain-named states, per-state SUMMARY contracts, routing); the engine owns *how* (protocol, validation, checkpointing, recovery, observability). The `code` skill is the pilot on this path; skills that have not migrated (`research`, `plan`, `prd`, `agent`, `jsa`, `sca`, `rez`) still run their own `orchestrate.py` FSM unchanged.

## Why

One engine replaces the ~10k lines of per-skill FSM plumbing that previously drifted out of sync. State no longer rides on `argv` (`--state`) or `/tmp` files, and there is no `extract_state`/`restore_state`/`_force_state`: a durable checkpointer keyed by `run_id` rehydrates every run. The JSON directive contract is unchanged, so the TS driver and every agent are untouched.

## Rules

1. **The skill dir holds only a thin delegate; the playbook is a real subclass.** The entire `.pi/skills/<name>/scripts/orchestrate.py` is:
   ```python
   #!/usr/bin/env python3
   from orchestration.cli import main
   if __name__ == "__main__":
       main(default_playbook="<name>")
   ```
   The FSM itself — states, `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate` — lives in the package's `playbooks/<name>.py` as a `BasePlaybook` subclass. There is no shared "standard cycle" base to inherit and no single-operation ("primitive") skill category — every skill is its own bespoke subclass.
2. **Four subcommands, via the package CLI.** `start`, `step`, `status`, `recover` — dispatched by `orchestration.cli:main`. `start` initializes + checkpoints; `step` validates the agent SUMMARY, routes, checkpoints; `status` reports; `recover` auto-resumes a pending run for the session (playbook-scoped).
3. **State lives in the durable checkpointer**, keyed by `run_id` (SQLite at `PENNY_ORCH_DB`, session-indexed). **Never** serialize state to `argv` and **never** reintroduce a transition-replay `_force_state`.
4. **One JSON directive per invocation to stdout.** No other stdout output; use stderr for logs.
5. **The agent SUMMARY is the only data returned to the engine.** Full output stays in MemPalace.

## Action Directives (unchanged vocabulary)

| Action | Purpose | Required fields |
|--------|---------|-----------------|
| `invoke_agent` | Dispatch single agent | `agent`, `task_summary`, `state_id`, `session_id`, `run_id` |
| `invoke_agents_parallel` | Dispatch multiple agents (fan-out state) | `tasks[]`, `state_id`, `session_id`, `run_id` |
| `escalate_to_user` | Pause for user input (UNCERTAIN escalation or a planned gate) | `questions[]`, `previous_state`, `session_id`, `run_id` |
| `complete` | Skill finished | `result`, `session_id`, `run_id` |
| `error` | Skill failed | `errors[]`, `session_id`, `run_id` |
| `status` | Report state | `state`, `complete`, `session_id`, `run_id` |

Every directive carries `run_id`. **No `orchestrator_state` blob** is echoed — the checkpointer owns state.

## Engine responsibilities (the base, not the skill)

- `start/step/status` protocol; summary gatekeeper (validates each state's SUMMARY against that state's `PrimitiveSpec.summary_contract`; fail loud on missing/mistyped fields).
- **Two HITL paths:** `confidence == UNCERTAIN` on an escalatable state → escalate (`unknown`→`awaiting_clarification`, `status=awaiting_user`); and **planned gates** (`GATE_STATES`) → pause with `gate_questions`, resume via `route_user` (multi-way).
- **Parallel fan-out:** a `PARALLEL_BY_STATE` state dispatches N branch agents in one directive and routes once on fan-in, aggregating branch SUMMARYs by weakest confidence.
- Checkpointing after every committed transition; resume by direct rehydrate (no replay).
- **Self-recovery:** bounded step-retry (transient failures), crash-resume (re-issue the pending step), auto-recovery scan (resume `running`/`awaiting_user` runs on start).
- Budgets: `max_iterations` (loops), global step cap, explicit done-predicate.
- Best-effort observability emission (never blocks the run).

## Skill (playbook) responsibilities

A concrete `BasePlaybook` subclass provides: `NAME`, `machine_cls` (its `python-statemachine` FSM with its own state names), `PRIMITIVE_BY_STATE`, `ESCALATABLE_STATES`, `initial_transition(ctx)`, `route_after(state, ctx, summary)`, `done_predicate(ctx)` — plus, as needed, `PARALLEL_BY_STATE`, `GATE_STATES` + `gate_questions`/`route_user`, and the optional `task_context_parts` / `result_payload` hooks. Domain run state that isn't in the standard `RunContext` fields goes in `RunContext.extras`.

## Constraints

- **No stdout except JSON directives.**
- **States must be safe to re-run** (crash-resume re-issues the pending step). An `ACT`-style state must be idempotent or split author/apply.
- **The engine imports no agent-side capability** (e.g. not `outcome_ledger`) — that work happens in the agent subprocess.

## Verification

- [ ] `orchestrate.py` is the 5-line delegate; the FSM lives in `playbooks/<name>.py` as a `BasePlaybook` subclass
- [ ] `start` returns the first directive; `step` routes on SUMMARY; `status` reports
- [ ] Kill mid-run → a fresh `step` (no `--state`) resumes from the checkpointer
- [ ] CI grep: zero `_force_state`, zero `--state` handling in the package
- [ ] A run emits correlated `orchestration_events` to the observability server (by `session_id`)

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/engine.py` | `BasePlaybook` engine |
| `apps/orchestration/src/orchestration/playbooks/code.py` | The `code` skill's playbook (the pilot subclass) |
| `apps/orchestration/src/orchestration/checkpointer.py` | Durable state (replaces `/tmp` + `_force_state`) |
| `docs/agents/orchestration/overview.md` | The orchestration package |
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/resilience.md` | Self-recovery & error handling |
