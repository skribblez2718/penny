# Skill State Management on the Orchestration Engine

This guide covers how Penny skills manage state. Every skill runs on **one shared orchestration engine** (`apps/orchestration/`, an installed package). The engine owns the state machine, the run protocol, and durable persistence. A skill contributes only its workflow — the states, their routing, and per-state contracts — as a `BasePlaybook` subclass.

> **Legacy note.** Skills used to ship their own `python-statemachine` FSM inside `scripts/orchestrate.py`, serialized to a `/tmp` session file via `--state`/`extract_state`/`restore_state`. That path is **removed**. There is no per-skill FSM, no `--state` argv, and no `/tmp` session file. `scripts/orchestrate.py` is now a ~5-line delegate.

## Why an Engine Instead of Per-Skill FSMs?

Skills have complex workflows:

- **Code Skill**: explore → analyze → plan → implement → verify ⇄ learn
- **Research Skill**: gather → verify → synthesize → report
- **Plan Skill**: explore → plan → critique → decompose

Encoding each as its own hand-rolled state machine meant every skill re-implemented resume, budgets, escalation, gates, and observability — inconsistently. The shared engine provides all of that once:

- **Durable resume**: run state is checkpointed to SQLite after every step, keyed by `run_id`. An interrupted run **auto-resumes** from its last checkpoint — no manual resume step, no session file to find.
- **SUMMARY contracts**: each state validates the agent's returned SUMMARY against that state's declared contract before routing.
- **Loop budgets**: retry loops are bounded by `ctx.max_iterations` and a global step cap; exhaustion is reported honestly (`complete` with `met=False`), never faked.
- **Escalation**: an agent emitting `confidence=UNCERTAIN`, or a stalled loop caught by `progress_check`, pauses the run at `awaiting_clarification`; the user's answer resumes it.
- **Planned gates**: declared HITL pause states present a questionnaire and route on the user's multi-way answer.
- **Parallel fan-out**: a state can dispatch N branch agents and aggregate their SUMMARYs.

## The Three Layers

| Layer | Responsibility | Where |
| ----- | -------------- | ----- |
| **Engine** | Runs the FSM, validates SUMMARYs, enforces budgets, checkpoints state, drives escalation/gates | `apps/orchestration/` (`engine.py`, `checkpointer.py`, `cli.py`) |
| **Playbook** | Declares this skill's states, routing, contracts, gates, escalation | `apps/orchestration/src/orchestration/playbooks/<skill>.py` |
| **Agents** | Do the actual work; write full output to mempalace, return a minimal SUMMARY | Pi subagents invoked by Penny on the engine's behalf |

State lives in the engine's checkpointer. Work happens in subagents. Cross-session knowledge lives in mempalace. These do not overlap.

## Anatomy of a Playbook

A playbook subclasses `BasePlaybook` and declares its workflow with class attributes and a few methods:

```python
from statemachine import State, StateMachine
from ..engine import BasePlaybook
from ..context import RunContext


class CodePlaybook(BasePlaybook):
    PRIMITIVE_BY_STATE = {...}          # which agent/primitive runs per state
    PARALLEL_BY_STATE = {...}           # fan-out states (optional)
    TOOL_STATES = frozenset(...)        # deterministic in-process states (optional)
    GATE_STATES = frozenset(...)        # planned HITL pause states (optional)
    ESCALATABLE_STATES = frozenset(...) # states that may escalate on UNCERTAIN / stall

    def done_predicate(self, ctx: RunContext) -> bool:
        """When is the run finished?"""

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        """Capture the SUMMARY into ctx and fire the FSM event(s) for the next state."""
```

The engine calls these. It never lives in the skill directory — the skill's `scripts/orchestrate.py` only does:

```python
from orchestration.cli import main
raise SystemExit(main(default_playbook="code"))
```

The engine reserves the standard states `awaiting_clarification`, `complete` (final), and `error` (final); the playbook supplies its own named working states in between.

## Standard Building Blocks

| Concern | Declare | Engine provides |
| ------- | ------- | --------------- |
| Per-state contract | The state's `PrimitiveSpec` SUMMARY schema | Validation + bounded retry on malformed SUMMARY |
| Routing | `route_after` | Fires the next transition after each SUMMARY |
| Completion | `done_predicate` | Routes to `complete` |
| Loop budget | `ctx.max_iterations` (from `constraints.max_iterations`, default 3) | Iteration cap + honest exhaustion |
| Escalation | `ESCALATABLE_STATES` (+ optional `progress_check`) | Pause at `awaiting_clarification`, resume on user answer |
| Planned gate | `GATE_STATES` + `gate_questions` + `route_user` | Pause with questionnaire, multi-way resume |
| Parallel fan-out | `PARALLEL_BY_STATE` | Dispatch N branches, aggregate SUMMARYs |
| Deterministic step | `TOOL_STATES` + `run_tool_state` (idempotent) | In-process state with no agent |

## Reference Implementations

- `apps/orchestration/src/orchestration/playbooks/code.py` — worked playbook (loop, both HITL gates, escalation, PRD dependency).
- `apps/orchestration/src/orchestration/playbooks/plan.py` — a second worked playbook.
- `apps/orchestration/tests/test_code_playbook.py` — how playbook tests are written (fresh instance per step against a tmp `Checkpointer`).
- `.pi/skills/code/SKILL.md` — the frontmatter reference (`metadata.penny.engine: orchestration`).

## Documentation Index

| Document | Description |
| -------- | ----------- |
| [Architecture](state-machine-architecture.md) | How the engine, playbooks, agents, checkpointer, and mempalace fit together |
| [Patterns](state-machine-patterns.md) | Common playbook patterns (loop, gate, parallel, escalation, tool state) |

## Next Steps

1. Read the [Architecture Guide](state-machine-architecture.md) to understand the layers.
2. Review [Patterns](state-machine-patterns.md) for playbook idioms.
3. Read `code.py` and `test_code_playbook.py` for a complete worked example.
