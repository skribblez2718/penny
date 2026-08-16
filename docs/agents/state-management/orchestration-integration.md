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
4. **Owner evidence stays outside model SUMMARY.** The skill driver grants exact `input_artifacts`, persists exact finalized output in the immutable artifact store, then sends result protocol v2 with the canonical ref and signed receipt beside the SUMMARY. SUMMARY remains the `PrimitiveSpec` routing payload; durable memory is neither handoff nor persistence authority.
5. **Do not persist by hand.** The engine checkpoints after every step. No `/tmp/<skill>-<session_id>.json`, no `extract_state`/`restore_state`, no `--state`.
6. **Routing, gates, escalation are engine seams.** Implement `route_after`, `done_predicate`, and (as needed) `gate_questions`/`route_user`, `progress_check` — do not print directives from the machine.

## Procedure/Constraints

### Layering

```
┌──────────────────────────────────────────────────────────────┐
│ scripts/orchestrate.py  (~5 lines)                           │
│   from orchestration.cli import main                         │
│   raise SystemExit(main(default_playbook="research"))        │
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

| Layer            | Responsibility                                               | Implementation             |
| ---------------- | ------------------------------------------------------------ | -------------------------- |
| **Delegate**     | Route argv to the engine CLI                                 | `orchestration.cli:main`   |
| **Playbook**     | FSM, per-state agent/contract, routing, gates, escalation    | `BasePlaybook` subclass    |
| **Engine**       | Advance the machine, dispatch, checkpoint, escalate, recover | `apps/orchestration/`      |
| **Checkpointer** | Durable run state keyed by `run_id`                          | SQLite (`checkpointer.py`) |

### A step

1. The owner captures exact agent output through `config.venvPython -m orchestration.artifact_cli put`, then calls `orchestrate.py step --session-id <sid> --run-id <rid> --agent <name> --result '<json>'` with result protocol v2 owner fields outside SUMMARY.
2. The engine loads the run by `run_id`, validates the trusted wrapper/summary according to the active protocol stage, and calls the playbook's `route_after(state, ctx, summary)`, which fires `self.sm.send("<event>")`.
3. The engine checkpoints the new `current_state_id`, then emits the directive for the new state (dispatch an agent, fan out in parallel, enter a gate, escalate, or finish).

```python
def route_after(self, state, ctx, summary):
    if state == "researching":
        self.sm.send("research_done")
    elif state == "validating":
        ctx.verify_verdict = summary["verdict"]
        self.sm.send("validate_pass" if summary["verdict"] == "PASS" else "validate_revise")
```

The engine builds the outgoing directive from `PRIMITIVE_BY_STATE[state]` (the agent + task summary). The playbook customizes the task text via `_task_summary` / `task_context_parts`; it does not print JSON itself.

### Starting a run

`start` validates required inputs, seeds `ctx.extras`, fires the initial transition, and lets the engine emit the first directive. The current research playbook sends an explicitly quick run straight to `researching`; other runs start at `planning`:

```python
def initial_transition(self, ctx):
    if not (ctx.goal or "").strip():
        raise RuntimeError("research requires a non-empty query")
    research = ctx.extras.setdefault("research", {})
    caller_mode = str(ctx.constraints.get("mode", ""))
    research["mode"] = caller_mode if caller_mode in MODES else ""
    # Seed bounded sub-query, fan-width, research-round, and rigor budgets.
    if caller_mode == "quick":
        self.sm.send("start_research")
        return "researching"
    self.sm.send("start_plan")
    return "planning"
```

### Planned gates (HITL)

A `GATE_STATES` state pauses the run. The engine calls `gate_questions` to present choices and marks the run `awaiting_user`; the user's answer resumes it via `step --agent user`, routed by `route_user`:

```python
GATE_STATES = frozenset({"review_gate"})

def gate_questions(self, state, ctx):
    return [{"id": "review", "prompt": "Approve, refine, or deny?"}]

def route_user(self, state, ctx, response):
    value = str(response.get("user_response", "")).strip().lower()
    if value == "approve":
        self.sm.send("review_approved")
    elif value == "deny":
        self.sm.send("review_denied")
    else:
        ctx.clarification_text = value
        self.sm.send("review_refine")
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

- Entering a `final=True` state (`complete` / `error`) ends the run; `done_predicate(ctx)` decides whether `complete` is a real success or an honest `met=False` exhaustion. `result_payload` exposes the selected exact product ref plus warnings and unresolved issues; it does not create routine memory or KG records.
- A run interrupted mid-step is recovered automatically (`recover_pending` / the `recover` CLI): the engine reloads by `run_id` and re-issues that step. States must be idempotent to re-enter; `TOOL_STATES` handlers must be safe to re-run.

### Directive reference

| Action                   | Purpose                             | Key fields                                                       |
| ------------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| `invoke_agent`           | Dispatch one agent                  | `agent`, `state_id`, `task_summary`, `run_id`, `output_artifact` |
| `invoke_agents_parallel` | Fan out a `PARALLEL_BY_STATE` state | `tasks[]` with exact `branch_id`/`output_artifact`, `run_id`     |
| `awaiting_user`          | Planned gate or escalation pause    | `questions[]`, `run_id` (no state blob)                          |
| `complete`               | Run finished                        | `result` (with honest `met`)                                     |
| `error`                  | Run failed / denied                 | `errors[]`                                                       |

## Verification

- [ ] `scripts/orchestrate.py` is the ~5-line delegate to `orchestration.cli:main`; no FSM or serialization in it.
- [ ] The playbook is a `BasePlaybook` subclass registered in `playbooks/__init__.py`; `SKILL.md` sets `metadata.penny.engine: orchestration`.
- [ ] `start` emits one directive; `step` validates the SUMMARY, routes via `route_after`, checkpoints, and emits the next directive.
- [ ] No non-JSON on orchestrator stdout; artifact CLI stdout is exactly one canonical `ArtifactRef`, and result protocol v2 carries that ref/receipt outside SUMMARY.
- [ ] Gates use `GATE_STATES`/`route_user`; escalation uses `ESCALATABLE_STATES`/`progress_check` — no printed directives, no state blob.
- [ ] No `/tmp` session file, no `--state`, no `extract_state`/`restore_state`; crash-resume works via `run_id` + `recover`.
- [ ] Terminal states report `met` honestly and store learnings; loops are capped by `ctx.max_iterations`/`STEP_CAP`.

## Files

| File                                                         | Purpose                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `docs/agents/state-management/orchestration-integration.md`  | This guide                                                             |
| `docs/agents/state-management/state-machine-reference.md`    | FSM + playbook API reference                                           |
| `docs/agents/state-management/skill-patterns.md`             | Reusable playbook workflow shapes                                      |
| `apps/orchestration/src/orchestration/playbooks/research.py` | Current playbook reference (fan-out, critique, validation, escalation) |
| `apps/orchestration/tests/test_research_playbook.py`         | Current playbook test reference (fresh instance + shared checkpointer) |
