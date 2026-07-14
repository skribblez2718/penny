"""Bitter-Lesson / atomic-loop compliance seams on the engine (PRD
/tmp/prd-orch-bitter-lesson — R3/R4/R5/R6/R8):

* safe completion default — base ``done_predicate`` is False (invariant 3);
* iteration-budget backstop — routing past ``max_iterations`` forces HONEST
  exhaustion (complete + ``met=False`` + ``exhausted`` reason), never a fake
  pass and never a silent loop-past to the step cap;
* evidence capture — a SUMMARY ``evidence`` field lands on
  ``ctx.verify_evidence`` and in the outcome-ledger body;
* default-on loop guards — a playbook with NO ``progress_check`` override gets
  strategy-repeat + stall escalation via engine auto-recorded iteration
  digests; ``LOOP_GUARDS = False`` opts out; playbook-recorded iterations are
  not double-recorded;
* model-owned routing — ``fire_model_route`` fires only declared, allowed,
  non-reserved events.
"""

import json

from statemachine import State, StateMachine

from orchestration.checkpointer import Checkpointer
from orchestration.context import RunContext
from orchestration.engine import BasePlaybook
from orchestration.outcome_writer import build_outcome_content
from orchestration.primitives.spec import PrimitiveSpec

SID, RID = "sess-comp", "run-comp"


# ---------------------------------------------------------------------------
# R3 — safe completion default
# ---------------------------------------------------------------------------


def test_base_done_predicate_never_claims_success(tmp_path):
    pb = BasePlaybook(Checkpointer(db_path=tmp_path / "orch.db"))
    ctx = RunContext(session_id=SID, run_id=RID, playbook="base")
    assert pb.done_predicate(ctx) is False


# ---------------------------------------------------------------------------
# A minimal act <-> learn retry loop used by the R4/R5/R6 tests. Deliberately
# does NOT override progress_check (exercises the default-on base guards) and
# does NOT override done_predicate (exercises the safe default at exhaustion).
# ---------------------------------------------------------------------------


class RetryMachine(StateMachine):
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


ACT_C = {"required": {"confidence": str}, "optional": {"evidence": list}}
LEARN_C = {
    "required": {"gap": bool},
    "optional": {"strategy_change": str, "gaps": list, "confidence": str},
}


class RetryPlaybook(BasePlaybook):
    NAME = "retry-test"
    machine_cls = RetryMachine
    PRIMITIVE_BY_STATE = {
        "acting": PrimitiveSpec("R_ACT", "skribble", ACT_C, "act"),
        "learning": PrimitiveSpec("R_LEARN", "carren", LEARN_C, "learn"),
    }
    ESCALATABLE_STATES = frozenset({"acting", "learning"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "acting"

    def route_after(self, state, ctx, summary):
        if state == "acting":
            self.sm.send("act_done")
        elif summary["gap"]:
            # Buggy-on-purpose: retries UNCONDITIONALLY (no exhaustion routing) —
            # this is exactly what the engine backstop must contain.
            ctx.iteration += 1
            self.sm.send("learn_retry")
        else:
            self.sm.send("learn_done")


class UnguardedRetryPlaybook(RetryPlaybook):
    NAME = "retry-unguarded"
    LOOP_GUARDS = False


def _start(cp, playbook=RetryPlaybook, constraints=None):
    return playbook(cp).start(
        session_id=SID, run_id=RID, goal="loop", constraints=constraints or {"max_iterations": 2}
    )


def _step(cp, agent, result, playbook=RetryPlaybook):
    return playbook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _cycle(cp, learn_summary, playbook=RetryPlaybook):
    _step(cp, "skribble", {"confidence": "PROBABLE"}, playbook)  # acting -> learning
    return _step(cp, "carren", learn_summary, playbook)


# ---------------------------------------------------------------------------
# R4 — iteration-budget backstop (honest exhaustion)
# ---------------------------------------------------------------------------


def test_routing_past_budget_forces_honest_exhaustion(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp)  # max_iterations=2
    _cycle(cp, {"gap": True})  # iteration 0 -> 1, loops back
    _cycle(cp, {"gap": True})  # iteration 1 -> 2, loops back (== max, still allowed)
    d = _cycle(cp, {"gap": True})  # iteration 2 -> 3 > max -> backstop fires
    assert d["action"] == "complete"
    assert d["result"]["met"] is False  # safe default, never fabricated
    assert d["result"]["exhausted"] is True
    assert "iteration budget exceeded" in d["result"]["exhausted_reason"]
    rec = cp.load(RID)
    assert rec.status == "complete"


def test_normal_completion_carries_no_exhaustion_flag(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp)
    d = _cycle(cp, {"gap": False})
    assert d["action"] == "complete"
    assert "exhausted" not in d["result"]


# ---------------------------------------------------------------------------
# R5 — evidence capture into ctx + outcome ledger
# ---------------------------------------------------------------------------


def test_summary_evidence_lands_on_context(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp)
    _step(cp, "skribble", {"confidence": "PROBABLE", "evidence": ["pytest: 12 passed", "lint: 0"]})
    rec = cp.load(RID)
    assert rec.context.verify_evidence == ["pytest: 12 passed", "lint: 0"]


def test_evidence_is_capped_and_stringified(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp)
    _step(cp, "skribble", {"confidence": "PROBABLE", "evidence": ["x" * 500, 42]})
    rec = cp.load(RID)
    assert rec.context.verify_evidence[0].endswith("…[truncated]")
    assert rec.context.verify_evidence[1] == "42"


def test_empty_evidence_is_not_captured(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp)
    _step(cp, "skribble", {"confidence": "PROBABLE", "evidence": []})
    rec = cp.load(RID)
    assert rec.context.verify_evidence == []


def test_outcome_body_records_evidence():
    ctx = RunContext(session_id=SID, run_id=RID, playbook="code")
    ctx.verify_evidence = ["pytest: 12 passed", "b", "c", "d"]
    body = json.loads(build_outcome_content(ctx).split("\n", 1)[1])
    assert body["verify_evidence"] == ["pytest: 12 passed", "b", "c"]  # capped at 3


# ---------------------------------------------------------------------------
# R6 — default-on loop guards (no progress_check override needed)
# ---------------------------------------------------------------------------


def test_default_guard_escalates_repeated_strategy(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp, constraints={"max_iterations": 5})
    _cycle(cp, {"gap": True, "strategy_change": "add index", "gaps": ["slow"]})
    d = _cycle(cp, {"gap": True, "strategy_change": "ADD  index", "gaps": ["other"]})
    assert d["action"] == "escalate_to_user"
    assert "anti-paralysis" in d["unknown_reason"]


def test_default_guard_escalates_stalled_gaps(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp, constraints={"max_iterations": 5})
    _cycle(cp, {"gap": True, "strategy_change": "s0", "gaps": ["same gap"]})
    _cycle(cp, {"gap": True, "strategy_change": "s1", "gaps": ["same gap"]})
    d = _cycle(cp, {"gap": True, "strategy_change": "s2", "gaps": ["same gap"]})
    assert d["action"] == "escalate_to_user"
    assert "stall guard" in d["unknown_reason"]


def test_changed_strategy_and_gaps_do_not_escalate(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp, constraints={"max_iterations": 5})
    _cycle(cp, {"gap": True, "strategy_change": "s0", "gaps": ["g0"]})
    d = _cycle(cp, {"gap": True, "strategy_change": "s1", "gaps": ["g1"]})
    assert d["action"] == "invoke_agent"  # keeps looping


def test_loop_guards_false_opts_out(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp, playbook=UnguardedRetryPlaybook, constraints={"max_iterations": 5})
    _cycle(cp, {"gap": True, "strategy_change": "same", "gaps": ["g"]}, UnguardedRetryPlaybook)
    d = _cycle(cp, {"gap": True, "strategy_change": "same", "gaps": ["g"]}, UnguardedRetryPlaybook)
    assert d["action"] == "invoke_agent"  # no guard, keeps looping


def test_engine_auto_records_iteration_digests(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp, constraints={"max_iterations": 5})
    _cycle(cp, {"gap": True, "strategy_change": "s0", "gaps": ["G A"], "confidence": "PROBABLE"})
    rec = cp.load(RID)
    assert rec.context.iteration_history == [
        {"iteration": 0, "strategy_change": "s0", "gaps": ["g a"], "confidence": "PROBABLE"}
    ]


def test_auto_record_dedupes_playbook_recorded_iterations(tmp_path):
    class SelfRecordingPlaybook(RetryPlaybook):
        NAME = "retry-selfrec"

        def route_after(self, state, ctx, summary):
            if state == "learning" and summary["gap"]:
                self.record_iteration(
                    ctx,
                    strategy_change=summary.get("strategy_change", ""),
                    gaps=summary.get("gaps", []),
                )
                ctx.iteration += 1
                self.sm.send("learn_retry")
            elif state == "learning":
                self.sm.send("learn_done")
            else:
                self.sm.send("act_done")

    cp = Checkpointer(db_path=tmp_path / "orch.db")
    _start(cp, playbook=SelfRecordingPlaybook, constraints={"max_iterations": 5})
    _cycle(cp, {"gap": True, "strategy_change": "s0", "gaps": ["g"]}, SelfRecordingPlaybook)
    rec = cp.load(RID)
    assert len(rec.context.iteration_history) == 1  # not double-recorded


# ---------------------------------------------------------------------------
# R8 — model-owned routing (fire_model_route)
# ---------------------------------------------------------------------------


class DialMachine(StateMachine):
    intake = State(initial=True)
    deciding = State()
    path_a = State()
    path_b = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(deciding)
    choose_a = deciding.to(path_a)
    choose_b = deciding.to(path_b)
    finish = path_a.to(complete) | path_b.to(complete)
    to_unknown = deciding.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(deciding)
    abort = (
        deciding.to(error)
        | path_a.to(error)
        | path_b.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


DIAL_C = {"required": {"confidence": str}, "optional": {"next_event": str}}


class DialPlaybook(BasePlaybook):
    """Model-owned routing: the whole route_after is fire_model_route + fallback."""

    NAME = "dial-test"
    machine_cls = DialMachine
    PRIMITIVE_BY_STATE = {
        "deciding": PrimitiveSpec("DECIDE", "skribble", DIAL_C, "decide"),
        "path_a": PrimitiveSpec("A", "skribble", DIAL_C, "a"),
        "path_b": PrimitiveSpec("B", "skribble", DIAL_C, "b"),
    }
    ESCALATABLE_STATES = frozenset({"deciding"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "deciding"

    def route_after(self, state, ctx, summary):
        if not self.fire_model_route(summary):  # the model picks the edge
            self.sm.send("finish" if state != "deciding" else "choose_a")  # code-owned fallback


def _dial(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    DialPlaybook(cp).start(session_id=SID, run_id=RID, goal="g")
    return cp


def test_model_chosen_legal_event_fires(tmp_path):
    cp = _dial(tmp_path)
    d = DialPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="skribble",
        result={"confidence": "CERTAIN", "next_event": "choose_b"},
    )
    assert d["state_id"] == "path_b"


def test_illegal_event_falls_back_without_moving(tmp_path):
    cp = _dial(tmp_path)
    d = DialPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="skribble",
        result={"confidence": "CERTAIN", "next_event": "not_an_edge"},
    )
    assert d["state_id"] == "path_a"  # fallback fired, not the bogus event


def test_reserved_event_is_refused(tmp_path):
    cp = _dial(tmp_path)
    d = DialPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="skribble",
        result={"confidence": "CERTAIN", "next_event": "abort"},
    )
    assert d["state_id"] == "path_a"  # reserved -> refused -> fallback


def test_absent_event_falls_back(tmp_path):
    cp = _dial(tmp_path)
    d = DialPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="skribble", result={"confidence": "CERTAIN"}
    )
    assert d["state_id"] == "path_a"


def test_fire_model_route_returns_false_unmoved(tmp_path):
    pb = DialPlaybook(Checkpointer(db_path=tmp_path / "orch.db"))
    pb.sm = DialMachine()
    pb.sm.send("start")
    assert pb.fire_model_route({"next_event": "finish"}) is False  # declared but not allowed here
    assert pb.sm.current_state_value == "deciding"
    assert pb.fire_model_route({"next_event": "choose_a"}) is True
    assert pb.sm.current_state_value == "path_a"
