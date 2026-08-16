"""Spend COMPUTE before spending HUMAN ATTENTION on an UNCERTAIN confidence.

The engine's only response to uncertainty was to stop and ask a person. Human
attention is the one resource that does not scale with compute, and the agent being
punished with an interrupt is the one that reported honestly — a tax on exactly the
calibration the system depends on.

These tests pin the mechanism AND, more importantly, its limits. A retry that leaked
into the genuine human seams (a question only the user can answer, a planned approval
gate, a stalled loop) would trade a safety property for a cost saving, which is a bad
trade at any exchange rate.
"""

from __future__ import annotations

import pytest
from statemachine import State, StateMachine

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import ParallelSpec, PrimitiveSpec

SID, RID = "sess-unc", "run-unc"
ENV = "PENNY_UNCERTAINTY_RETRY"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv(ENV, "1")


@pytest.fixture(autouse=True)
def _default_off(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)


class UMachine(StateMachine):
    intake = State(initial=True)
    working = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)
    start = intake.to(working)
    work_done = working.to(complete)
    to_unknown = working.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(working)
    abort = working.to(error) | unknown.to(error) | awaiting_clarification.to(error)


_C = {
    "required": {"done": bool, "confidence": str},
    "optional": {"needs_clarification": bool, "gaps": list, "unknown_reason": str},
}
WORK = PrimitiveSpec("WORK", "echo", _C, "do the work")


class UPlaybook(BasePlaybook):
    NAME = "unc-test"
    machine_cls = UMachine
    PRIMITIVE_BY_STATE = {"working": WORK}
    ESCALATABLE_STATES = frozenset({"working"})
    LOOP_GUARDS = False

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "working"

    def route_after(self, state, ctx, summary):
        self.sm.send("work_done")

    def done_predicate(self, ctx):
        return True


def _start(cp):
    return UPlaybook(cp).start(session_id=SID, run_id=RID, goal="g")


def _step(cp, summary, agent="echo"):
    return UPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=summary)


# ---------------------------------------------------------------------------
# default OFF
# ---------------------------------------------------------------------------


def test_uncertain_escalates_immediately_when_disabled(cp):
    _start(cp)
    d = _step(cp, {"done": False, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert cp.load(RID).status == STATUS_AWAITING_USER


# ---------------------------------------------------------------------------
# enabled: one bounded compute retry, then the human
# ---------------------------------------------------------------------------


def test_uncertain_is_retried_once_before_escalating(cp, on):
    _start(cp)
    d = _step(
        cp, {"done": False, "confidence": "UNCERTAIN", "unknown_reason": "two sources conflict"}
    )
    assert d["action"] == "invoke_agent" and d["state_id"] == "working"

    # a SECOND uncertain report on the same state goes to the human
    d = _step(cp, {"done": False, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user"
    assert cp.load(RID).status == STATUS_AWAITING_USER


def test_retry_directive_targets_the_uncertainty_and_forbids_faking_confidence(cp, on):
    _start(cp)
    d = _step(
        cp, {"done": False, "confidence": "UNCERTAIN", "unknown_reason": "two sources conflict"}
    )
    task = d["task_summary"]
    assert "RETRY AFTER UNCERTAINTY" in task
    assert "two sources conflict" in task
    assert "Spend this attempt on the specific thing you were unsure about" in task
    # The safety property: the retry must NOT become pressure to fake certainty.
    assert "report UNCERTAIN again" in task
    assert "Do NOT upgrade your confidence" in task


def test_a_resolved_retry_proceeds_normally(cp, on):
    _start(cp)
    _step(cp, {"done": False, "confidence": "UNCERTAIN"})
    d = _step(cp, {"done": True, "confidence": "PROBABLE"})
    assert d["action"] == "complete" and d["result"]["met"] is True


def test_retry_budget_is_checkpointed(cp, on):
    """Each step builds a FRESH playbook, so the budget must survive the process\n    boundary or a crash-resume would grant unlimited retries."""
    _start(cp)
    _step(cp, {"done": False, "confidence": "UNCERTAIN"})
    assert cp.load(RID).context.extras["uncertainty_retried"] == ["working"]


# ---------------------------------------------------------------------------
# the limits that must hold — genuine human seams are untouched
# ---------------------------------------------------------------------------


def test_needs_clarification_never_retries_even_when_enabled(cp, on):
    """A question only the user can answer cannot be resolved by re-running."""
    _start(cp)
    d = _step(cp, {"done": False, "confidence": "UNCERTAIN", "needs_clarification": True})
    assert d["action"] == "escalate_to_user"


def test_a_stalled_run_escalates_without_a_retry(cp, on):
    """progress_check stalls mean the run is stuck — re-running it is the one thing\n    already known not to work."""

    class StallPlaybook(UPlaybook):
        def progress_check(self, state, ctx, summary):
            return "no measurable progress across iterations"

    StallPlaybook(cp).start(session_id=SID, run_id=RID, goal="g")
    d = StallPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="echo", result={"done": False, "confidence": "PROBABLE"}
    )
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


def test_non_escalatable_state_is_unaffected(cp, on):
    class NoEscPlaybook(UPlaybook):
        ESCALATABLE_STATES = frozenset()

    NoEscPlaybook(cp).start(session_id=SID, run_id=RID, goal="g")
    d = NoEscPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="echo", result={"done": True, "confidence": "UNCERTAIN"}
    )
    assert d["action"] == "complete"  # routed normally, never escalated or retried


# ---------------------------------------------------------------------------
# parallel fan-out: a DOCUMENTED exclusion, pinned so it cannot drift silently
# ---------------------------------------------------------------------------


class ParMachine(StateMachine):
    intake = State(initial=True)
    scanning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)
    start = intake.to(scanning)
    scan_done = scanning.to(complete)
    to_unknown = scanning.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(scanning)
    abort = scanning.to(error) | unknown.to(error) | awaiting_clarification.to(error)


_B = {"required": {"passed": bool, "confidence": str}, "optional": {}}


class ParPlaybook(BasePlaybook):
    NAME = "par-unc"
    machine_cls = ParMachine
    PARALLEL_BY_STATE = {
        "scanning": ParallelSpec(
            branches={
                "a": PrimitiveSpec("A", "vera", _B, "a"),
                "b": PrimitiveSpec("B", "echo", _B, "b"),
            }
        )
    }
    ESCALATABLE_STATES = frozenset({"scanning"})
    LOOP_GUARDS = False

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "scanning"

    def route_after(self, state, ctx, summary):
        self.sm.send("scan_done")

    def done_predicate(self, ctx):
        return True


def test_parallel_fan_still_escalates_on_an_uncertain_branch(cp, on):
    """Excluded on purpose: re-dispatching a fan re-runs EVERY branch to resolve one,
    and the fan protocol has no single-branch re-dispatch. Fixing that means
    persisting the good branch summaries and re-dispatching only the weak ones —
    named follow-on work, not something to smuggle in behind a flag."""
    ParPlaybook(cp).start(session_id="p", run_id="p", goal="g")
    batch = [
        {
            "branch_id": "a",
            "agent": "vera",
            "exitCode": 0,
            "summary": {"passed": True, "confidence": "CERTAIN"},
        },
        {
            "branch_id": "b",
            "agent": "echo",
            "exitCode": 0,
            "summary": {"passed": False, "confidence": "UNCERTAIN"},
        },
    ]
    d = ParPlaybook(cp).step(session_id="p", run_id="p", agent="__parallel__", result=batch)
    assert d["action"] == "escalate_to_user"
