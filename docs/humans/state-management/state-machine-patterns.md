# Common Playbook Patterns

Ready-to-use patterns for building a skill as a `BasePlaybook` subclass on the shared orchestration engine (`apps/orchestration/`). Each pattern uses the engine's building blocks — states, `route_after`, `done_predicate`, gates, fan-out, escalation, and tool states — rather than a hand-rolled per-skill FSM.

> **Legacy note.** These patterns replace the old `python-statemachine`-in-`orchestrate.py` recipes with their `/tmp` session files and `SessionManager` JSON persistence. That path is **removed**: run state lives in the engine's durable checkpointer keyed by `run_id`, and a skill's `scripts/orchestrate.py` is a ~5-line delegate. The current worked implementation is `playbooks/research.py`.

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

A fixed chain of workers, each receiving the exact owner-granted predecessor artifact. Use it when each phase has a clear predecessor and the sequence benefits from durable checkpoints.

```python
class PipelinePlaybook(BasePlaybook):
    ESCALATABLE_STATES = frozenset({"gathering", "synthesizing", "validating"})

    def route_after(self, state, ctx, summary):
        ctx.set(f"{state}_summary", summary)
        if state == "gathering":
            self.sm.send("to_synthesizing")
        elif state == "synthesizing":
            self.sm.send("to_validating")
        elif state == "validating":
            self.sm.send("to_writing")
        elif state == "writing":
            self.sm.send("to_complete")

    def done_predicate(self, ctx):
        return ctx.get("writing_summary") is not None
```

Each state's SUMMARY contract validates routing fields. Complete stage bytes stay in immutable owner artifacts; only compact SUMMARY data and selected refs flow through `ctx`.

## Pattern 2: Bounded Retry Loop (Ralph Wiggum)

Iterate act → verify → learn until the goal is met or the budget is spent. This is useful whenever verification can identify an actionable gap for the next attempt.

```python
class RepairPlaybook(BasePlaybook):
    ESCALATABLE_STATES = frozenset({"acting", "verifying", "learning"})

    def route_after(self, state, ctx, summary):
        if state == "learning":
            if not summary["gap"]:
                self.sm.send("to_final_verify")        # one final verify → complete
            elif ctx.iteration < ctx.max_iterations:
                self.sm.send("to_acting")              # retry with the gap findings
            else:
                # Budget spent — complete honestly, never fake success.
                ctx.set("met", False)
                self.sm.send("to_complete")
```

Rules the engine enforces for you:

- `ctx.max_iterations` (from `constraints.max_iterations`, default 3) caps the loop; a global step cap caps everything.
- Exhaustion completes with `met=False` — the run records the miss instead of fabricating a pass.
- A `verifying` state must ground its SUMMARY in a real oracle (lint / type-check / tests), not a self-report.

### Stall detection

Wire `progress_check` so a loop that keeps retrying the _same_ failing strategy escalates instead of spinning:

```python
def progress_check(self, state, ctx, summary):
    if state == "learning" and self.strategy_repeated(ctx, summary):
        return "retry loop stalled: same strategy failed twice"
    return None
```

Returning a reason on an escalatable state pauses the run at `awaiting_clarification`.

## Pattern 3: Planned HITL Gate

Pause for an explicit user decision at a known point before expensive, external, or hard-to-reverse work.

```python
class ApprovalPlaybook(BasePlaybook):
    GATE_STATES = frozenset({"approval_gate"})

    def gate_questions(self, state, ctx):
        if state == "approval_gate":
            return [{
                "id": "decision",
                "prompt": "Approve this approach?",
                "options": ["approve", "refine", "deny"],
            }]
        ...

    def route_user(self, state, ctx, response):
        if state == "approval_gate":
            if response == "approve":
                self.sm.send("to_executing")
            elif response == "refine":
                self.sm.send("to_revising")
            else:  # deny → terminate honestly
                self.sm.send("to_error")
```

The engine pauses the run at the gate, surfaces the questionnaire, and resumes on the user's answer via `route_user`. The gated work does not begin before an `approve`.

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

A step that runs in-process with no agent — validation, setup, or another pure computation.

```python
class SetupPlaybook(BasePlaybook):
    TOOL_STATES = frozenset({"preparing"})

    def run_tool_state(self, state, ctx):
        # MUST be idempotent — a crash-resumed run re-issues this step.
        if state == "preparing":
            ctx.set("normalized_inputs", normalize(ctx.get("inputs")))
```

`run_tool_state` runs synchronously inside `step`; make it safe to re-run, because an interrupted run re-issues the state on resume.

## Testing a Playbook

Drive the engine step by step against a temporary checkpointer, asserting the state transition and captured SUMMARY at each step. Use a fresh playbook instance per step to prove crash-resume works (state comes from the checkpointer, not the object). See `apps/orchestration/tests/test_research_playbook.py` for the current reference pattern:

```python
def test_gather_to_synthesize(tmp_path):
    cp = Checkpointer(tmp_path / "runs.db")
    run_id = start_run(PipelinePlaybook, cp, goal=..., constraints=...)

    # Fresh instance each step — state is loaded from the checkpointer by run_id.
    directive = step(PipelinePlaybook, cp, run_id, agent="echo", summary={...})
    assert directive["action"] == "invoke_agent"
    assert directive["agent"] == "synthia"      # gathering → synthesizing
```

## Related

- [State Management](state-management.md) — the engine model and building blocks.
- [Architecture](state-machine-architecture.md) — how engine, playbook, workers, checkpointer, artifacts, and optional primary memory fit together.
- `apps/orchestration/src/orchestration/playbooks/research.py` — current worked playbook.
