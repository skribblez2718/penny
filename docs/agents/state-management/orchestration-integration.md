# Orchestration Integration — How the engine drives a playbook

## What

This document describes how a skill's FSM runs on the **shared orchestration engine** (`apps/orchestration/`, an installed package) and how the engine emits the JSON action directives Penny consumes. Every Penny skill runs this way. A skill ships a `BasePlaybook` subclass (its FSM + behavior) registered in `playbooks/__init__.py`, plus a ~5-line `scripts/orchestrate.py` delegate. There is no per-skill runtime, no `--state` argv, and no `/tmp` session file — the engine persists run state in a durable `run_id`-keyed SQLite checkpointer and resumes automatically after a crash.

## Why

Penny invokes a skill's `orchestrate.py` as a subprocess, once per turn. The delegate hands off to `orchestration.cli:main`, which loads the run by `run_id` from the checkpointer, advances the shared engine one step, and emits the next directive. The JSON action protocol decouples skill logic from agent invocation; the engine makes every skill resumable and testable outside the main agent loop.

## Rules

1. **`orchestrate.py` is a thin delegate.** Its entire body is `from orchestration.cli import main; raise SystemExit(main(default_playbook="<skill>"))`. No FSM, no serialization, no directive printing of its own.
2. **The FSM + behavior live in the package.** `apps/orchestration/src/orchestration/playbooks/<skill>.py` defines the `StateMachine` (`machine_cls`) and the `BasePlaybook` subclass; register it in `playbooks/__init__.py`.
3. **Subcommands are `start`, `step`, `status`, `recover`** — all handled by the engine CLI, not the skill.
   - `start` creates a run (keyed by `run_id`) and emits the first directive.
   - `step --agent <name> --result <json>` consumes an agent SUMMARY and emits the next directive.
   - `status` reports current state; `recover` re-issues an interrupted step.
4. **Agent SUMMARY is the only payload passed back.** The engine validates it against the state's `PrimitiveSpec` contract. Full agent output lives in MemPalace.
5. **Do not persist by hand.** The engine checkpoints after every step. No `/tmp/<skill>-<session_id>.json`, no `extract_state`/`restore_state`, no `--state`.
6. **Routing, gates, escalation are engine seams.** Implement `route_after`, `done_predicate`, and (as needed) `gate_questions`/`route_user`, `progress_check` — do not print directives from the machine.

## Procedure/Constraints

### Layering

```
┌──────────────────────────────────────────────────────────────┐
│ scripts/orchestrate.py  (~5 lines)                           │
│   from orchestration.cli import main                         │
│   raise SystemExit(main(default_playbook="code"))            │
└───────────────┬──────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│ orchestration engine (installed package)                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ BasePlaybook subclass                                   │  │
│  │   machine_cls = <StateMachine>   (phases + events)      │  │
│  │   PRIMITIVE_BY_STATE / PARALLEL_BY_STATE / TOOL_STATES  │  │
│  │   GATE_STATES / ESCALATABLE_STATES                      │  │
│  │   route_after / done_predicate / gate_questions ...     │  │
│  └────────────────────────────────────────────────────────┘  │
│        │ dispatch agent        │ save/load by run_id          │
│        ▼                       ▼                              │
│   JSON directive          Checkpointer (SQLite, run_id key)  │
│   to stdout               — durable, auto-resume             │
└──────────────────────────────────────────────────────────────┘
```

| Layer | Responsibility | Implementation |
| --- | --- | --- |
| **Delegate** | Route argv to the engine CLI | `orchestration.cli:main` |
| **Playbook** | FSM, per-state agent/contract, routing, gates, escalation | `BasePlaybook` subclass |
| **Engine** | Advance the machine, dispatch, checkpoint, escalate, recover | `apps/orchestration/` |
| **Checkpointer** | Durable run state keyed by `run_id` | SQLite (`checkpointer.py`) |

### A step

1. Penny calls `orchestrate.py step --session-id <sid> --run-id <rid> --agent <name> --result '<json>'`.
2. The engine loads the run by `run_id`, validates the SUMMARY against the current state's contract, and calls the playbook's `route_after(state, ctx, summary)`, which fires `self.sm.send("<event>")`.
3. The engine checkpoints the new `current_state_id`, then emits the directive for the new state (dispatch an agent, fan out in parallel, enter a gate, escalate, or finish).

```python
def route_after(self, state, ctx, summary):
    if state == "implementing":
        self.sm.send("implement_done")
    elif state == "verifying":
        ctx.verify_verdict = "PASS" if summary["passed"] else "FAIL"
        self.sm.send("verify_done" if not summary["passed"] else "final_verify_pass")
```

The engine builds the outgoing directive from `PRIMITIVE_BY_STATE[state]` (the agent + task summary). The playbook customizes the task text via `_task_summary` / `task_context_parts`; it does not print JSON itself.

### Starting a run

`start` resolves any hard dependency, seeds `ctx.extras`, fires the initial transition, and lets the engine emit the first directive:

```python
def initial_transition(self, ctx):
    ideal = load_ideal_state(ctx.constraints, ctx.project_root)
    if not ideal or not ideal.get("success_criteria"):
        raise RuntimeError(_PRD_DEPENDENCY_ERROR)   # engine turns this into an error directive
    ctx.extras.setdefault("code", {})["ideal_state"] = ideal
    ctx.success_criteria = list(ideal["success_criteria"])
    self.sm.send("start_explore")
    return "exploring"
```

### Planned gates (HITL)

A `GATE_STATES` state pauses the run. The engine calls `gate_questions` to present choices and marks the run `awaiting_user`; the user's answer resumes it via `step --agent user`, routed by `route_user`:

```python
GATE_STATES = frozenset({"plan_gate"})

def gate_questions(self, state, ctx):
    return [_plan_approval_question(ctx, ctx.extras["code"])]

def route_user(self, state, ctx, response):
    value = str(response.get("user_response", "")).strip().lower()
    if value == "approve":   self.sm.send("plan_approved")
    elif value == "deny":    self.sm.send("plan_denied")   # terminal error
    else:
        ctx.clarification_text = value
        self.sm.send("plan_refine")
```

### Escalation (confidence / stall)

When an agent in an `ESCALATABLE_STATES` state returns `confidence=UNCERTAIN` — or `progress_check` returns a reason (repeated strategy, stall) — the engine drives the machine to `unknown` → `awaiting_clarification` and pauses. The user's answer resumes via `step --agent user` and the machine's `clarify` edge. No `orchestrator_state` / `previous_state` blob is emitted; the run state is already durable under `run_id`.

```python
def progress_check(self, state, ctx, summary):
    if state == "learning" and summary.get("gap"):
        if ctx.iteration >= 1 and self.strategy_repeated(ctx, summary.get("strategy_change", "")):
            return "the next iteration repeats the previous strategy — escalating rather than spinning"
        if self.is_stalled(ctx, summary.get("findings", [])):
            return "the same gaps persist with no measurable progress — escalating"
    return None
```

### Completion & crash-resume

- Entering a `final=True` state (`complete` / `error`) ends the run; `done_predicate(ctx)` decides whether `complete` is a real success or an honest `met=False` exhaustion. Learnings are written to MemPalace by the terminal-state handlers/`result_payload`.
- A run interrupted mid-step is recovered automatically (`recover_pending` / the `recover` CLI): the engine reloads by `run_id` and re-issues that step. States must be idempotent to re-enter; `TOOL_STATES` handlers must be safe to re-run.

### Directive reference

| Action | Purpose | Key fields |
| --- | --- | --- |
| `invoke_agent` | Dispatch one agent | `agent`, `state_id`, `task_summary`, `run_id` |
| `invoke_agents_parallel` | Fan out a `PARALLEL_BY_STATE` state | `tasks[]`, `run_id` |
| `awaiting_user` | Planned gate or escalation pause | `questions[]`, `run_id` (no state blob) |
| `complete` | Run finished | `result` (with honest `met`) |
| `error` | Run failed / denied | `errors[]` |

## Verification

- [ ] `scripts/orchestrate.py` is the ~5-line delegate to `orchestration.cli:main`; no FSM or serialization in it.
- [ ] The playbook is a `BasePlaybook` subclass registered in `playbooks/__init__.py`; `SKILL.md` sets `metadata.penny.engine: orchestration`.
- [ ] `start` emits one directive; `step` validates the SUMMARY, routes via `route_after`, checkpoints, and emits the next directive.
- [ ] No non-JSON on stdout; full agent output is in MemPalace, only the SUMMARY comes back.
- [ ] Gates use `GATE_STATES`/`route_user`; escalation uses `ESCALATABLE_STATES`/`progress_check` — no printed directives, no state blob.
- [ ] No `/tmp` session file, no `--state`, no `extract_state`/`restore_state`; crash-resume works via `run_id` + `recover`.
- [ ] Terminal states report `met` honestly and store learnings; loops are capped by `ctx.max_iterations`/`STEP_CAP`.

## Files

| File | Purpose |
| --- | --- |
| `docs/agents/state-management/orchestration-integration.md` | This guide |
| `docs/agents/state-management/state-machine-reference.md` | FSM + playbook API reference |
| `docs/agents/state-management/skill-patterns.md` | Reusable playbook workflow shapes |
| `apps/orchestration/src/orchestration/playbooks/code.py` | Worked reference playbook (gates, loop, escalation) |
| `apps/orchestration/tests/test_code_playbook.py` | How playbook steps are tested (fresh instance + shared checkpointer) |
</content>
