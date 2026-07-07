# Skill Patterns — Reusable playbook workflows

## What

Ready-to-use workflow shapes for common skills — TDD cycle, research flow, decision flow, iterative refinement, event/HITL-driven — expressed as `BasePlaybook` subclasses on the shared orchestration engine. Each shape is a `StateMachine` (states + events) plus the playbook hooks that route it: `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate`, and — as needed — `GATE_STATES`, `PARALLEL_BY_STATE`, `progress_check`.

## Why

Most Penny skills follow one of a few workflow shapes. Starting from a shape keeps machines consistent and makes them predictable to route, escalate, and test. All shapes run on the SAME engine (`apps/orchestration/`); a skill never ships its own runtime or persistence — state is durable in the engine's `run_id`-keyed checkpointer.

## Rules

1. **Choose the simplest shape that fits.** Add gates, parallel fan-out, or tool states only when the workflow needs them.
2. **The machine holds no data; routing reads the SUMMARY.** `route_after` inspects the agent summary and calls `self.sm.send("<event>")`. Per-run data lives on `RunContext` (`ctx.extras`, `ctx.iteration`).
3. **Every loop is bounded.** Cap retries with `ctx.max_iterations` (and the global `STEP_CAP`); route exhaustion to a terminal state that reports `met=False` — never fabricate success.
4. **One agent (or one parallel batch) per working state.** Each state maps to exactly one `PrimitiveSpec` in `PRIMITIVE_BY_STATE`, or one `ParallelSpec` in `PARALLEL_BY_STATE`.
5. **Do not persist by hand.** No `/tmp` session file, no `--state`, no `extract_state`/`restore_state`. The engine checkpoints after every step and auto-resumes on crash.
6. **Escalation is a seam, not an ad-hoc print.** Add states to `ESCALATABLE_STATES`; `confidence=UNCERTAIN` or a `progress_check` reason pauses the run at `awaiting_clarification`.

### Pattern selection guide

| Workflow shape | Pattern | Engine features |
| --- | --- | --- |
| Red-green-refactor with retry loop | TDD cycle | `route_after` loopback + `ctx.max_iterations` |
| Gather → analyze → synthesize | Research flow | Conditional routing; optional `PARALLEL_BY_STATE` gather |
| Frame → explore → evaluate → decide | Decision flow | Routing on criteria/option counts; optional `GATE_STATES` |
| Improve → evaluate until threshold | Iterative refinement | Bounded loop + honest exhaustion edge |
| Wait for user / external input | Event / HITL | `GATE_STATES` (planned) or `awaiting_clarification` (escalation) |

## Procedure/Constraints

Each pattern below shows the `StateMachine` and the playbook hooks. `PrimitiveSpec`/`ParallelSpec` definitions and per-state task prompts are elided for brevity — see `orchestration/playbooks/code.py` and `plan.py` for full examples.

### Pattern 1: TDD cycle (red → green → refactor, bounded retry)

```python
from statemachine import State, StateMachine
from orchestration.engine import BasePlaybook

class TDDMachine(StateMachine):
    red = State(initial=True)
    green = State()
    refactor = State()
    verifying = State()
    complete = State(final=True)
    error = State(final=True)

    wrote_test = red.to(green)
    made_pass = green.to(refactor)
    refactored = refactor.to(verifying)
    verify_retry = verifying.to(red)        # gap && within budget
    verify_done = verifying.to(complete)    # oracle passed
    exhausted = verifying.to(complete)      # budget spent; met=False

class TDDPlaybook(BasePlaybook):
    NAME = "tdd"
    machine_cls = TDDMachine
    PRIMITIVE_BY_STATE = {"red": TDD_RED, "green": TDD_GREEN,
                          "refactor": TDD_REFACTOR, "verifying": TDD_VERIFY}
    ESCALATABLE_STATES = frozenset({"green", "verifying"})

    def route_after(self, state, ctx, summary):
        if state == "red": self.sm.send("wrote_test")
        elif state == "green": self.sm.send("made_pass")
        elif state == "refactor": self.sm.send("refactored")
        elif state == "verifying":
            if summary["passed"]:
                self.sm.send("verify_done")
            elif ctx.iteration + 1 < ctx.max_iterations:
                ctx.iteration += 1
                self.sm.send("verify_retry")
            else:
                self.sm.send("exhausted")

    def done_predicate(self, ctx):
        return ctx.extras.get("verify_passed", False)
```

### Pattern 2: Research flow (gather → analyze → synthesize)

Gather (optionally fan-out via `PARALLEL_BY_STATE`), analyze, synthesize; loop back to gather while confidence is low and rounds remain.

```python
class ResearchMachine(StateMachine):
    gathering = State(initial=True)
    analyzing = State()
    synthesizing = State()
    complete = State(final=True)
    error = State(final=True)

    gathered = gathering.to(analyzing)
    analyzed = analyzing.to(synthesizing)
    more_data = synthesizing.to(gathering)   # low confidence && rounds remain
    done = synthesizing.to(complete)

class ResearchPlaybook(BasePlaybook):
    NAME = "research"
    machine_cls = ResearchMachine
    PARALLEL_BY_STATE = {"gathering": RESEARCH_GATHER}   # fan-out N source agents
    PRIMITIVE_BY_STATE = {"analyzing": RESEARCH_ANALYZE, "synthesizing": RESEARCH_SYNTH}

    def route_after(self, state, ctx, summary):
        if state == "gathering": self.sm.send("gathered")
        elif state == "analyzing": self.sm.send("analyzed")
        elif state == "synthesizing":
            if summary.get("confidence") == "LOW" and ctx.iteration + 1 < ctx.max_iterations:
                ctx.iteration += 1
                self.sm.send("more_data")
            else:
                self.sm.send("done")

    def done_predicate(self, ctx):
        return ctx.extras.get("confidence") != "LOW"   # honest: report low-confidence completions
```

### Pattern 3: Decision flow (frame → explore → evaluate → decide, with a gate)

Explore options, evaluate against criteria, then pause at a planned HITL gate before recording the decision.

```python
class DecisionMachine(StateMachine):
    framing = State(initial=True)
    exploring = State()
    evaluating = State()
    decide_gate = State()          # HITL: confirm / revise
    deciding = State()
    complete = State(final=True)
    error = State(final=True)

    framed = framing.to(exploring)
    explored = exploring.to(evaluating)
    need_more = evaluating.to(exploring)     # < 2 options
    evaluated = evaluating.to(decide_gate)
    confirmed = decide_gate.to(deciding)
    revise = decide_gate.to(exploring)
    recorded = deciding.to(complete)

class DecisionPlaybook(BasePlaybook):
    NAME = "decision"
    machine_cls = DecisionMachine
    GATE_STATES = frozenset({"decide_gate"})
    PRIMITIVE_BY_STATE = {"framing": DEC_FRAME, "exploring": DEC_EXPLORE,
                          "evaluating": DEC_EVAL, "deciding": DEC_RECORD}

    def gate_questions(self, state, ctx):
        return [{"id": "decide", "label": "Confirm decision", "prompt": "...",
                 "options": [{"value": "confirm", "label": "Confirm"},
                             {"value": "revise", "label": "Revise"}]}]

    def route_user(self, state, ctx, response):
        value = str(response.get("user_response", "")).strip().lower()
        self.sm.send("confirmed" if value == "confirm" else "revise")
```

### Pattern 4: Iterative refinement (improve → evaluate until threshold)

```python
class RefineMachine(StateMachine):
    refining = State(initial=True)
    evaluating = State()
    complete = State(final=True)
    error = State(final=True)

    refined = refining.to(evaluating)
    again = evaluating.to(refining)       # below threshold && budget remains
    good = evaluating.to(complete)        # threshold met
    exhausted = evaluating.to(complete)   # budget spent; met=False

class RefinePlaybook(BasePlaybook):
    NAME = "refine"
    machine_cls = RefineMachine
    PRIMITIVE_BY_STATE = {"refining": REF_IMPROVE, "evaluating": REF_EVAL}
    ESCALATABLE_STATES = frozenset({"evaluating"})

    def route_after(self, state, ctx, summary):
        if state == "refining":
            self.sm.send("refined")
        elif state == "evaluating":
            if summary["score"] >= summary["threshold"]:
                self.sm.send("good")
            elif ctx.iteration + 1 < ctx.max_iterations:
                ctx.iteration += 1
                self.sm.send("again")
            else:
                self.sm.send("exhausted")
```

### Pattern 5: Event / HITL-driven

Two ways to wait for a human, both handled by the engine (no ad-hoc JSON printing, no state blob):

- **Planned gate** — a `GATE_STATES` state pauses the run and presents `gate_questions`; the user's choice resumes it via `route_user` (see Pattern 3).
- **Escalation** — an agent in an `ESCALATABLE_STATES` state emits `confidence=UNCERTAIN` (or `progress_check` returns a reason); the engine drives the machine to `awaiting_clarification` and pauses. The user's answer resumes via `step --agent user` and the machine's `clarify` edge.

Use a planned gate when the pause is expected at a fixed point (plan approval, decision confirmation). Use escalation when an agent hits genuine uncertainty mid-flow.

### Simple vs. parallel states

| Use simple sequential states when... | Use `PARALLEL_BY_STATE` when... |
| --- | --- |
| The workflow is a straight sequence or a bounded loop | One phase fans out into N independent branch agents that all report before routing |
| Routing is easy to scan in `route_after` | The engine aggregates the branch SUMMARYs before `route_after` runs (see `plan.py`) |

## Verification

- [ ] The chosen shape matches the actual workflow; no unused gates/parallel/tool states.
- [ ] Each working state maps to one `PrimitiveSpec` (or one `ParallelSpec`); routing is in `route_after`.
- [ ] Every loop is capped by `ctx.max_iterations`/`STEP_CAP` and ends in a terminal state; `done_predicate` reports `met` honestly.
- [ ] HITL uses `GATE_STATES` (planned) or `ESCALATABLE_STATES` (escalation) — not ad-hoc stdout or a state blob.
- [ ] No manual persistence (`/tmp`, `--state`, `extract_state`/`restore_state`); the engine checkpoints and auto-resumes.
- [ ] The playbook is registered in `orchestration/playbooks/__init__.py` and reachable via the 5-line `orchestrate.py` delegate.

## Files

| File | Purpose |
| --- | --- |
| `docs/agents/state-management/skill-patterns.md` | This pattern catalog |
| `docs/agents/state-management/state-machine-reference.md` | FSM + playbook API details |
| `docs/agents/state-management/orchestration-integration.md` | How the engine drives a playbook |
| `apps/orchestration/src/orchestration/playbooks/code.py` | TDD-cycle reference (loop + two gates) |
| `apps/orchestration/src/orchestration/playbooks/plan.py` | Parallel-fan-out reference |
</content>
