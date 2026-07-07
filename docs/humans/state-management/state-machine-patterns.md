# Common Playbook Patterns

Ready-to-use patterns for building a skill as a `BasePlaybook` subclass on the shared orchestration engine (`apps/orchestration/`). Each pattern uses the engine's building blocks — states, `route_after`, `done_predicate`, gates, fan-out, escalation, and tool states — rather than a hand-rolled per-skill FSM.

> **Legacy note.** These patterns replace the old `python-statemachine`-in-`orchestrate.py` recipes with their `/tmp` session files and `SessionManager` JSON persistence. That path is **removed**: run state lives in the engine's durable checkpointer keyed by `run_id`, and a skill's `scripts/orchestrate.py` is a ~5-line delegate. Study `playbooks/code.py` and `playbooks/plan.py` for full worked examples.

## The Shape of Every Playbook

```python
from statemachine import State, StateMachine
from ..engine import BasePlaybook
from ..context import RunContext


class MyPlaybook(BasePlaybook):
    # -- declare the workflow --------------------------------------------
    PRIMITIVE_BY_STATE = {...}            # agent/primitive per state
    ESCALATABLE_STATES = frozenset({...}) # states that may pause on UNCERTAIN/stall

    def done_predicate(self, ctx: RunContext) -> bool:
        ...

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        # capture the SUMMARY into ctx, then fire the transition to the next state
        ...
```

The engine reserves `awaiting_clarification`, `complete` (final), and `error` (final). Register the playbook in `playbooks/__init__.py` and add the delegate at `.pi/skills/<skill>/scripts/orchestrate.py`.

## Pattern 1: Sequential Pipeline

A fixed chain of agents, each reading the prior one's output from mempalace. This is the backbone of the plan skill (explore → plan → critique → decompose).

```python
class PlanPlaybook(BasePlaybook):
    ESCALATABLE_STATES = frozenset({"exploring", "planning", "critiquing"})

    def route_after(self, state, ctx, summary):
        ctx.set(f"{state}_summary", summary)
        if state == "exploring":
            self.sm.send("to_planning")
        elif state == "planning":
            self.sm.send("to_critiquing")
        elif state == "critiquing":
            self.sm.send("to_decomposing")
        elif state == "decomposing":
            self.sm.send("to_complete")

    def done_predicate(self, ctx):
        return ctx.get("decomposing_summary") is not None
```

Each state's SUMMARY contract validates that the agent returned the fields the next state needs. The full artifact stays in mempalace; only the SUMMARY flows through `ctx`.

## Pattern 2: Bounded Retry Loop (Ralph Wiggum)

Iterate implement → verify → learn until the goal is met or the budget is spent. This is the core of the code skill.

```python
class CodePlaybook(BasePlaybook):
    ESCALATABLE_STATES = frozenset({"implementing", "verifying", "learning"})

    def route_after(self, state, ctx, summary):
        if state == "learning":
            if not summary["gap"]:
                self.sm.send("to_final_verify")        # one final verify → complete
            elif ctx.iteration < ctx.max_iterations:
                self.sm.send("to_implementing")        # retry with the gap findings
            else:
                # budget spent — complete HONESTLY, never fake success
                ctx.set("met", False)
                self.sm.send("to_complete")
```

Rules the engine enforces for you:

- `ctx.max_iterations` (from `constraints.max_iterations`, default 3) caps the loop; a global step cap caps everything.
- Exhaustion completes with `met=False` — the run records the miss instead of fabricating a pass.
- A `verifying` state must ground its SUMMARY in a real oracle (lint / type-check / tests), not a self-report.

### Stall detection

Wire `progress_check` so a loop that keeps retrying the *same* failing strategy escalates instead of spinning:

```python
def progress_check(self, state, ctx, summary):
    if state == "learning" and self.strategy_repeated(ctx, summary):
        return "retry loop stalled: same strategy failed twice"
    return None
```

Returning a reason on an escalatable state pauses the run at `awaiting_clarification`.

## Pattern 3: Planned HITL Gate

Pause for an explicit user decision at a known point. The code skill gates twice: a criteria gate and a plan-approval gate.

```python
class CodePlaybook(BasePlaybook):
    GATE_STATES = frozenset({"criteria_gate", "plan_gate"})

    def gate_questions(self, state, ctx):
        if state == "plan_gate":
            return [{
                "id": "decision",
                "prompt": "Approve this plan?",
                "options": ["approve", "refine", "deny"],
            }]
        ...

    def route_user(self, state, ctx, response):
        if state == "plan_gate":
            if response == "approve":
                self.sm.send("to_implementing")
            elif response == "refine":
                self.sm.send("to_planning")
            else:  # deny → terminate honestly
                self.sm.send("to_error")
```

The engine pauses the run at the gate, surfaces the questionnaire, and resumes on the user's answer via `route_user`. No code is written before an `approve`.

## Pattern 4: Parallel Fan-Out

Dispatch N branch agents at once and route once on the aggregate. Useful when independent analyses can run concurrently (e.g. multiple reviewers).

```python
class ReviewPlaybook(BasePlaybook):
    PARALLEL_BY_STATE = {"reviewing": ParallelSpec(...)}  # declares the N branches

    def route_after(self, state, ctx, summary):
        if state == "reviewing":
            # summary == {"branches": {branch_id: SUMMARY, ...},
            #             "confidence": <weakest branch>}
            ctx.set("reviews", summary["branches"])
            self.sm.send("to_synthesizing")
```

Each branch's SUMMARY is validated against the state's contract; the engine aggregates them into `{"branches": {...}, "confidence": <weakest>}` and routes once. If the weakest branch is `UNCERTAIN` on an escalatable state, the run escalates.

## Pattern 5: Escalate on Uncertainty

Let an agent honestly say "I don't know" and pause for the user instead of guessing.

```python
class ResearchPlaybook(BasePlaybook):
    ESCALATABLE_STATES = frozenset({"gathering", "verifying", "synthesizing"})
```

When an agent on one of these states returns `confidence: UNCERTAIN`, the engine pauses at `awaiting_clarification` and surfaces the agent's question. The user's answer resumes the run via `step --agent user`. The paused run is keyed by `run_id` — there is no `orchestrator_state` blob to pass around.

## Pattern 6: Deterministic Tool State

A step that runs in-process with no agent — detection, setup, a pure computation. The code skill uses one to enrich the IDEAL_STATE with server-startup detection before exploring.

```python
class CodePlaybook(BasePlaybook):
    TOOL_STATES = frozenset({"detecting"})

    def run_tool_state(self, state, ctx):
        # MUST be idempotent — a crash-resumed run re-issues this step.
        if state == "detecting":
            ctx.set("server_project", detect_server(ctx.get("project_root")))
```

`run_tool_state` runs synchronously inside `step`; make it safe to re-run, because an interrupted run re-issues the state on resume.

## Testing a Playbook

Drive the engine step by step against a temporary checkpointer, asserting the state transition and the captured SUMMARY at each step. Use a fresh playbook instance per step to prove crash-resume works (state comes from the checkpointer, not the object). See `apps/orchestration/tests/test_code_playbook.py` for the reference pattern:

```python
def test_explore_to_analyze(tmp_path):
    cp = Checkpointer(tmp_path / "runs.db")
    run_id = start_run(CodePlaybook, cp, goal=..., constraints=...)

    # fresh instance each step — state is loaded from the checkpointer by run_id
    directive = step(CodePlaybook, cp, run_id, agent="echo", summary={...})
    assert directive["action"] == "invoke_agent"
    assert directive["agent"] == "annie"        # exploring → analyzing
```

## Related

- [State Management](state-management.md) — the engine model and building blocks.
- [Architecture](state-machine-architecture.md) — how engine, playbook, agents, checkpointer, and mempalace fit together.
- `apps/orchestration/src/orchestration/playbooks/code.py`, `plan.py` — worked playbooks.
