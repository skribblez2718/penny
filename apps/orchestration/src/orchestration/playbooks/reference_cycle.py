"""ReferenceCycle — the engine's smoke-test fixture.

A full OBSERVE->FRAME->PLAN->ACT<->VERIFY->LEARN run on the engine, registered
ONLY so the engine/CLI/recovery/observability tests can drive an end-to-end run.

It is NOT a base class and NOT a shape domain skills inherit: every domain skill
subclasses ``BasePlaybook`` directly with its own states, PrimitiveSpecs and
per-state summary contracts (see ``playbooks/code.py`` for the real pattern).
This fixture is also the canonical example of the ``task_context_parts`` /
``result_payload`` hooks.
"""

from __future__ import annotations

from statemachine import State, StateMachine

from ..contracts import VERDICT_PASS, VERDICTS
from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives import ACT, FRAME, LEARN, OBSERVE, PLAN, VERIFY


class ReferenceCycleMachine(StateMachine):
    """The FSM graph. Transitions are fired by the playbook's route_after /
    initial_transition and by the engine's standard escalation/error events."""

    intake = State(initial=True)
    observing = State()
    framing = State()
    planning = State()
    acting = State()
    verifying = State()
    learning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    # entry
    start_observe = intake.to(observing)
    start_frame = intake.to(framing)
    # main cycle
    observe_done = observing.to(framing)
    frame_done = framing.to(planning)
    plan_done = planning.to(acting)
    act_done = acting.to(verifying)
    verify_pass = verifying.to(learning)
    verify_fail = verifying.to(acting)
    verify_exhausted = verifying.to(learning)
    learn_done = learning.to(complete)
    # standard escalation events (engine contract)
    to_unknown = (
        framing.to(unknown) | planning.to(unknown) | acting.to(unknown) | verifying.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(framing)
    # standard error events (engine contract)
    abort = (
        observing.to(error)
        | framing.to(error)
        | planning.to(error)
        | acting.to(error)
        | verifying.to(error)
        | learning.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


class ReferenceCycle(BasePlaybook):
    NAME = "reference-cycle"
    machine_cls = ReferenceCycleMachine
    PRIMITIVE_BY_STATE = {
        "observing": OBSERVE,
        "framing": FRAME,
        "planning": PLAN,
        "acting": ACT,
        "verifying": VERIFY,
        "learning": LEARN,
    }
    ESCALATABLE_STATES = frozenset({"framing", "planning", "acting", "verifying"})

    def done_predicate(self, ctx: RunContext) -> bool:
        return ctx.verify_verdict == VERDICT_PASS

    def initial_transition(self, ctx: RunContext) -> str:
        # Subset: skip OBSERVE when evidence is already supplied.
        if ctx.constraints.get("evidence_ref"):
            self.sm.send("start_frame")
            return "framing"
        self.sm.send("start_observe")
        return "observing"

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        if state == "observing":
            self.sm.send("observe_done")
        elif state == "framing":
            ctx.success_criteria = summary["success_criteria"]
            self.sm.send("frame_done")
        elif state == "planning":
            ctx.plan_steps = summary["plan_steps"]
            self.sm.send("plan_done")
        elif state == "acting":
            self.sm.send("act_done")
        elif state == "verifying":
            verdict = summary["verdict"]
            ctx.verify_verdict = verdict
            ctx.verify_gaps = summary.get("gaps", [])
            if verdict == VERDICT_PASS:
                self.sm.send("verify_pass")
            elif verdict not in VERDICTS:
                # Unknown verdict is a hard contract violation -> terminal error
                # (route_after exceptions are caught by the engine).
                raise ValueError(
                    f"unknown VERIFY verdict {verdict!r} (expected one of {sorted(VERDICTS)})"
                )
            elif ctx.iteration + 1 < ctx.max_iterations:
                ctx.iteration += 1
                self.sm.send("verify_fail")
            else:
                self.sm.send("verify_exhausted")
        elif state == "learning":
            self.sm.send("learn_done")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    # -- cycle-specific hook overrides (the base defaults are cycle-neutral) --
    def task_context_parts(self, state: str, ctx: RunContext) -> list[str]:
        parts: list[str] = []
        if state == "acting" and ctx.verify_gaps:
            parts.append(f"Address these gaps from the prior verification: {ctx.verify_gaps}")
        if state == "verifying" and ctx.success_criteria:
            parts.append(f"Judge against success_criteria: {ctx.success_criteria}")
        return parts

    def result_payload(self, ctx: RunContext) -> dict:
        return {
            "met": ctx.met,
            "verify_verdict": ctx.verify_verdict,
            "iterations": ctx.iteration,
            "success_criteria": ctx.success_criteria,
            "gaps": ctx.verify_gaps,
        }
