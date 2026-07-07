"""Tests for the loop-quality guards (research/loop-research Recs 1 & 2):
strategy-delta enforcement between retries, stall / progress-assessment, and the
``iteration_history`` bookkeeping they ride on — driven end-to-end through a small
inline retry playbook. Also covers the ``__parallel__`` fan-in agent guard.

Like the other seam tests, each step() builds a FRESH playbook instance against
the same checkpointer, so these exercise the durable run_id contract too.
"""

import pytest
from statemachine import State, StateMachine

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import PrimitiveSpec

SID, RID = "sess-loop", "run-loop"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


# ---------------------------------------------------------------------------
# A minimal act <-> learn retry loop whose LEARN state opts into the guards.
# ---------------------------------------------------------------------------


class LoopMachine(StateMachine):
    intake = State(initial=True)
    acting = State()
    learning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(acting)
    act_done = acting.to(learning)
    learn_retry = learning.to(acting)
    learn_done = learning.to(complete)
    to_unknown = learning.to(unknown) | acting.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(acting)
    abort = (
        acting.to(error) | learning.to(error) | unknown.to(error) | awaiting_clarification.to(error)
    )


ACT_C = {"required": {"confidence": str}, "optional": {}}
LEARN_C = {"required": {"gap": bool}, "optional": {"strategy_change": str, "gaps": list}}
LOOP_ACT = PrimitiveSpec("LOOP_ACT", "skribble", ACT_C, "act")
LOOP_LEARN = PrimitiveSpec("LOOP_LEARN", "carren", LEARN_C, "learn")


class LoopPlaybook(BasePlaybook):
    NAME = "loop-test"
    machine_cls = LoopMachine
    PRIMITIVE_BY_STATE = {"acting": LOOP_ACT, "learning": LOOP_LEARN}
    ESCALATABLE_STATES = frozenset({"acting", "learning"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "acting"

    def progress_check(self, state, ctx, summary):
        if state == "learning" and summary.get("gap"):
            # About to retry: refuse a repeated strategy or a stalled loop.
            if ctx.iteration >= 1 and self.strategy_repeated(
                ctx, summary.get("strategy_change", "")
            ):
                return "retry repeats a failed strategy — escalating (anti-paralysis)"
            if self.is_stalled(ctx, summary.get("gaps", [])):
                return "no measurable progress across iterations — escalating"
        return None

    def route_after(self, state, ctx, summary):
        if state == "acting":
            self.sm.send("act_done")
        elif state == "learning":
            if not summary["gap"]:
                self.sm.send("learn_done")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(
                    ctx,
                    strategy_change=summary.get("strategy_change", ""),
                    gaps=summary.get("gaps", []),
                    confidence=summary.get("confidence", ""),
                )
                ctx.iteration += 1
                self.sm.send("learn_retry")
            else:
                self.sm.send("learn_done")


def _start(cp, constraints=None):
    return LoopPlaybook(cp).start(
        session_id=SID, run_id=RID, goal="loop", constraints=constraints or {"max_iterations": 5}
    )


def _step(cp, agent, result):
    return LoopPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _act_then_learn(cp, learn_summary):
    """acting -> learning with a canned ACT SUMMARY, then feed the LEARN SUMMARY."""
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # acting -> learning
    return _step(cp, "carren", learn_summary)


# ---------------------------------------------------------------------------
# Strategy-delta (Rec 1)
# ---------------------------------------------------------------------------


def test_first_retry_is_allowed(cp):
    _start(cp)
    d = _act_then_learn(cp, {"gap": True, "strategy_change": "add index", "gaps": ["slow query"]})
    # iteration 0: no strategy check yet -> loops back to acting
    assert d["state_id"] == "acting"


def test_repeated_strategy_escalates(cp):
    _start(cp)
    _act_then_learn(cp, {"gap": True, "strategy_change": "add index", "gaps": ["slow query"]})
    # iteration 1: same strategy as iteration 0 -> escalate instead of spinning
    d = _act_then_learn(cp, {"gap": True, "strategy_change": "Add   INDEX", "gaps": ["other"]})
    assert d["action"] == "escalate_to_user"
    assert "anti-paralysis" in d["unknown_reason"]
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER


def test_changed_strategy_and_new_gaps_continue(cp):
    _start(cp)
    _act_then_learn(cp, {"gap": True, "strategy_change": "add index", "gaps": ["slow query"]})
    # iteration 1: different strategy AND different gaps -> keep looping
    d = _act_then_learn(
        cp, {"gap": True, "strategy_change": "cache results", "gaps": ["cold cache"]}
    )
    assert d["state_id"] == "acting"


def test_missing_strategy_change_counts_as_repeat(cp):
    _start(cp)
    _act_then_learn(cp, {"gap": True, "strategy_change": "add index", "gaps": ["a"]})
    # iteration 1 with NO strategy_change -> treated as a repeat -> escalate
    d = _act_then_learn(cp, {"gap": True, "gaps": ["b"]})
    assert d["action"] == "escalate_to_user"


# ---------------------------------------------------------------------------
# Stall / progress-assessment (Rec 2)
# ---------------------------------------------------------------------------


def test_identical_gaps_across_iterations_escalate(cp):
    _start(cp)
    # Distinct strategies (so the strategy guard never fires), identical gaps.
    _act_then_learn(cp, {"gap": True, "strategy_change": "s0", "gaps": ["same gap"]})
    _act_then_learn(cp, {"gap": True, "strategy_change": "s1", "gaps": ["same gap"]})
    d = _act_then_learn(cp, {"gap": True, "strategy_change": "s2", "gaps": ["same gap"]})
    assert d["action"] == "escalate_to_user"
    assert "no measurable progress" in d["unknown_reason"]


def test_no_gap_completes_without_escalation(cp):
    _start(cp)
    d = _act_then_learn(cp, {"gap": False})
    assert d["action"] == "complete"


# ---------------------------------------------------------------------------
# iteration_history durability
# ---------------------------------------------------------------------------


def test_iteration_history_survives_the_checkpointer(cp):
    _start(cp)
    _act_then_learn(cp, {"gap": True, "strategy_change": "add index", "gaps": ["slow"]})
    rec = cp.load(RID)
    assert rec.context.iteration_history == [
        {"iteration": 0, "strategy_change": "add index", "gaps": ["slow"], "confidence": ""}
    ]


# ---------------------------------------------------------------------------
# strategy_repeated / is_stalled unit behavior
# ---------------------------------------------------------------------------


def test_strategy_repeated_helper(cp):
    pb = LoopPlaybook(cp)
    ctx = _ctx()
    assert pb.strategy_repeated(ctx, "") is True  # empty always "repeats"
    ctx.iteration_history.append({"strategy_change": "add index", "gaps": []})
    assert pb.strategy_repeated(ctx, "ADD  index") is True  # normalized match
    assert pb.strategy_repeated(ctx, "use a cache") is False


def test_is_stalled_helper(cp):
    pb = LoopPlaybook(cp)
    ctx = _ctx()
    assert pb.is_stalled(ctx, ["g"]) is False  # no history
    ctx.iteration_history.append({"gaps": ["same"]})
    ctx.iteration_history.append({"gaps": ["same"]})
    assert pb.is_stalled(ctx, ["same"]) is True
    assert pb.is_stalled(ctx, ["different"]) is False
    assert pb.is_stalled(ctx, []) is False  # empty current gaps never stall


def _ctx():
    from orchestration.context import RunContext

    return RunContext(session_id=SID, run_id=RID, playbook="loop-test")
