"""Engine integration test for the graduated-autonomy gate.

Verifies the opt-in hook in ``_advance_to``: before dispatching an action state
(AUTONOMY_STATES), the engine consults the autonomy decision and — when it says
ASK — escalates to the human via the existing HITL path instead of proceeding.
Dormant unless PENNY_AUTONOMY_GATE is set, so existing runs are unaffected.

The autonomy DECISION itself is monkeypatched here (its own logic is unit-tested
in scripts/system/autonomy/tests); this test proves the ENGINE wiring.
"""

import pytest
from statemachine import State, StateMachine

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import PrimitiveSpec
import orchestration.engine as engine_mod

SID, RID = "sess-auto", "run-auto"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


class ActMachine(StateMachine):
    intake = State(initial=True)
    acting = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)
    start = intake.to(acting)
    act_done = acting.to(complete)
    to_unknown = acting.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(acting)
    abort = acting.to(error) | unknown.to(error) | awaiting_clarification.to(error)


_ONE_C = {"required": {"confidence": str}, "optional": {}}
ACT = PrimitiveSpec("ACT", "skribble", _ONE_C, "act")


class ActPlaybook(BasePlaybook):
    NAME = "autonomy-test"
    machine_cls = ActMachine
    PRIMITIVE_BY_STATE = {"acting": ACT}
    ESCALATABLE_STATES = frozenset({"acting"})
    AUTONOMY_STATES = frozenset({"acting"})

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "acting"

    def route_after(self, state, ctx, summary):
        if state == "acting":
            self.sm.send("act_done")

    def route_user(self, state, ctx, response):
        # Human approved → return to the action state.
        self.sm.send("clarify")


def _start(cp, goal="do the thing"):
    return ActPlaybook(cp).start(session_id=SID, run_id=RID, goal=goal)


def _step(cp, agent, result):
    return ActPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def test_gate_dormant_by_default_dispatches_action(cp, monkeypatch):
    # Without PENNY_AUTONOMY_GATE the gate never runs → the action dispatches.
    monkeypatch.delenv("PENNY_AUTONOMY_GATE", raising=False)
    d = _start(cp)
    assert d["action"] == "invoke_agent" and d["state_id"] == "acting"


def test_gate_escalates_when_decision_is_ask(cp, monkeypatch):
    # Gate says ASK → the engine escalates to the human BEFORE acting.
    monkeypatch.setattr(engine_mod, "_autonomy_ask_reason", lambda action: "coding untrusted")
    d = _start(cp)
    assert d["action"] == "escalate_to_user"
    assert "Autonomy: coding untrusted" in d["unknown_reason"]
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "awaiting_clarification"


def test_gate_proceeds_when_decision_is_act(cp, monkeypatch):
    # Gate says ACT (None reason) → the action dispatches normally.
    monkeypatch.setattr(engine_mod, "_autonomy_ask_reason", lambda action: None)
    d = _start(cp)
    assert d["action"] == "invoke_agent" and d["state_id"] == "acting"


def test_gate_is_one_shot_no_reescalation_loop(cp, monkeypatch):
    # After the human answers, re-entering the action state must NOT re-escalate
    # (trust is unchanged, so re-asking would loop forever). Human approval wins once.
    calls = {"n": 0}

    def always_ask(action):
        calls["n"] += 1
        return "untrusted"

    monkeypatch.setattr(engine_mod, "_autonomy_ask_reason", always_ask)
    d1 = _start(cp)
    assert d1["action"] == "escalate_to_user"  # first entry escalates
    d2 = _step(cp, "user", {"answer": "proceed"})
    assert d2["action"] == "invoke_agent" and d2["state_id"] == "acting"  # proceeds, no loop
    assert calls["n"] == 1  # gate consulted exactly once despite two entries


def test_autonomy_action_defaults_to_goal(cp, monkeypatch):
    # The action text classified is the run's goal by default.
    seen = {}

    def spy(action_text):
        seen["action"] = action_text
        return None

    monkeypatch.setattr(engine_mod, "_autonomy_ask_reason", spy)
    _start(cp, goal="deploy the service to production")
    assert seen["action"] == "deploy the service to production"
