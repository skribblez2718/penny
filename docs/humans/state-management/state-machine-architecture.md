# State Machine Architecture for Skills

This document explains how Penny's skills run on the shared **orchestration engine** — how the engine, a skill's playbook, the subagents, the durable checkpointer, and mempalace fit together.

> **Legacy note.** The per-skill `python-statemachine` FSM inside `scripts/orchestrate.py`, with its `/tmp` JSON session file and `--state` transport, is **removed**. State now lives in the engine's durable SQLite checkpointer keyed by `run_id`, and `scripts/orchestrate.py` is a ~5-line delegate.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  SKILL.md   (metadata.penny.engine: orchestration → routes here)   │
│  scripts/orchestrate.py   (~5-line delegate to orchestration.cli)  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Orchestration engine  (apps/orchestration/)                       │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ BasePlaybook subclass  (playbooks/<skill>.py)                │ │
│  │   states → route_after → done_predicate                      │ │
│  │   per-state SUMMARY contracts, gates, escalation, fan-out    │ │
│  └──────────────────────────────────────────────────────────────┘ │
│         │                    │                     │               │
│         ▼                    ▼                     ▼               │
│  ┌─────────────┐    ┌─────────────┐     ┌────────────────────┐    │
│  │ Subagents   │    │ Mempalace   │     │ Checkpointer       │    │
│  │ (execution) │    │ (knowledge) │     │ (run state, SQLite │    │
│  │             │    │             │     │  keyed by run_id)  │    │
│  └─────────────┘    └─────────────┘     └────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

## The Layers

### Layer 1: Engine + Playbook (What Phase?)

The engine runs a `python-statemachine` FSM. The **playbook** declares the phases and how they connect; the **engine** drives them, validates each SUMMARY, enforces budgets, checkpoints, and handles escalation and gates.

```python
from statemachine import State, StateMachine
from ..engine import BasePlaybook
from ..context import RunContext


class CodePlaybook(BasePlaybook):
    ESCALATABLE_STATES = frozenset(
        {"exploring", "analyzing", "planning", "implementing", "verifying", "learning"}
    )

    def done_predicate(self, ctx: RunContext) -> bool:
        return ctx.get("final_verify_passed", False)

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        # capture SUMMARY into ctx, fire the transition to the next state
        ...
```

**Responsibilities (engine):**

- Advance the FSM one step per `step` call.
- Validate each state's SUMMARY against that state's declared contract; retry a malformed SUMMARY within a bounded budget.
- Enforce the loop cap (`ctx.max_iterations`) and a global step cap.
- Checkpoint run state after every step.
- Pause at `awaiting_clarification` on `UNCERTAIN`/stall; pause at declared gates.

**Responsibilities (playbook):** declare states, `route_after`, `done_predicate`, and — as needed — `GATE_STATES`/`gate_questions`/`route_user`, `PARALLEL_BY_STATE`, `TOOL_STATES`/`run_tool_state`, `ESCALATABLE_STATES`/`progress_check`.

**Neither does:** execute domain work (subagents), store cross-session knowledge (mempalace).

### Layer 2: Subagent (Do the Work)

The engine emits an `invoke_agent` directive; Penny runs the named Pi subagent with the skill's Domain Guidance. The agent does the real work — reads files, writes code, runs commands — in an isolated context, writes its **full output to mempalace**, and returns a **minimal SUMMARY** to the engine (via Penny).

**Responsibilities:**

- Execute code, run commands, write files, using all Pi tools.
- Write full output to mempalace; return a compact SUMMARY matching the state's contract.
- Report uncertainty honestly (`confidence: UNCERTAIN`) rather than guessing — that triggers escalation.

**Does NOT:** hold workflow state (the engine's checkpointer does), know about other skills (isolation), or store cross-session learnings (mempalace does).

### Layer 3: Mempalace (Knowledge)

Mempalace holds working notes and cross-session knowledge. Agents read prior states' full output from the run's mempalace room and write their own output back. The engine passes only SUMMARY metadata between states — never the full text — which keeps Penny's context lean.

**Does NOT:** store run/FSM state (that is the checkpointer's job), or execute work (subagents do).

## Run State and the Checkpointer

Run state — current state id, iteration count, captured per-state SUMMARYs, status — is persisted to a SQLite database keyed by `run_id` (`apps/orchestration/checkpointer.py`). The engine `save`s after every step and `load`s by `run_id` on resume.

There is **no** `--state` argv, **no** `/tmp/<skill>-<session>.json`, and **no** `extract_state`/`restore_state`/`_force_state`. The `run_id` in each engine directive is the only handle Penny carries; the full state stays in SQLite.

### Data Flow (one step)

1. Penny calls `step`, handing back the previous agent's SUMMARY and the `run_id`.
2. The engine `load`s the run by `run_id`, validates the SUMMARY against the current state's contract.
3. If `UNCERTAIN` or a `progress_check` stall fires on an escalatable state → pause at `awaiting_clarification`.
4. Otherwise `route_after` fires the transition; the engine `save`s the new state.
5. The engine emits the next directive (`invoke_agent`, `invoke_agents_parallel`, a gate questionnaire, `complete`, or `error`).

## Crash Recovery

Because state is checkpointed after every step, an interrupted run **auto-resumes** from its last good checkpoint on the next invocation — the engine re-issues the step that was in flight (agent SUMMARYs are captured only after they validate, and `run_tool_state` must be idempotent, so re-issuing is safe). Recovery is driven by the engine's `recover` path (`recover`/`recover_pending`), not by a manual reload of a session file.

## Escalation and Gates

- **Escalation (unplanned).** An agent emitting `confidence=UNCERTAIN` on a state in `ESCALATABLE_STATES`, or a stall detected by `progress_check` (repeated strategy, no forward progress), pauses the run at `awaiting_clarification`. The user's answer resumes the run via `step --agent user`. There is no `orchestrator_state` blob — the `run_id` keys the paused run.
- **Gate (planned).** A state in `GATE_STATES` pauses the run and presents `gate_questions(...)` as a questionnaire. The user's multi-way answer is routed by `route_user(...)` (e.g. approve / refine / deny). The code skill uses this for its criteria gate and its plan-approval gate.

## Loop Quality

Every retry loop is bounded by `ctx.max_iterations` (from `constraints.max_iterations`, default 3) and a global step cap. When a loop exhausts its budget without meeting the goal, the run completes **honestly** — `complete` with `met=False` — recording the miss rather than fabricating success. `progress_check` plus strategy-delta / stall detection escalate a spinning loop. VERIFY states must back their SUMMARY with real evidence from an oracle (tests, type-check), not a self-report.

## Best Practices

1. **Keep `ctx` minimal** — store only what routing and contracts need.
2. **Do work in subagents** — the playbook routes, agents execute.
3. **Make `run_tool_state` idempotent** — a re-issued step must be safe.
4. **Declare an honest `done_predicate`** — completion means the goal is met or the budget is spent, never a fake success.
5. **Put escalatable states in `ESCALATABLE_STATES`** so `UNCERTAIN`/stalls actually pause instead of guessing.
6. **Test the playbook step by step** against a tmp `Checkpointer` (see `test_code_playbook.py`).
7. **Store learnings in mempalace**, run state in the checkpointer — never mix the two.
