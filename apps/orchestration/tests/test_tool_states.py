"""Tests for TOOL_STATES — deterministic in-process states (no agent) that the
engine executes inline and advances past, used by the security skills' scan
phases (sca P2/P7, jsa acquire/sast). Covers the inline run, chained tool states,
mid-tool crash recovery, and the fail-loud guards.
"""

import pytest
from statemachine import State, StateMachine

from orchestration.checkpointer import STATUS_RUNNING, Checkpointer
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import PrimitiveSpec

SID, RID = "sess-tool", "run-tool"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


class ScanMachine(StateMachine):
    intake = State(initial=True)
    baseline = State()  # tool state (deterministic scan)
    targeted = State()  # tool state (deterministic scan)
    triage = State()  # agent state
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(baseline)
    baseline_done = baseline.to(targeted)
    targeted_done = targeted.to(triage)
    triage_done = triage.to(complete)
    to_unknown = triage.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(triage)
    abort = (
        baseline.to(error)
        | targeted.to(error)
        | triage.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


TRIAGE = PrimitiveSpec("TRIAGE", "annie", {"required": {"triaged": bool}, "optional": {}}, "triage")


class ScanPlaybook(BasePlaybook):
    NAME = "scan-test"
    machine_cls = ScanMachine
    TOOL_STATES = frozenset({"baseline", "targeted"})
    PRIMITIVE_BY_STATE = {"triage": TRIAGE}

    def initial_transition(self, ctx):
        self.sm.send("start")
        return "baseline"

    def run_tool_state(self, state, ctx):
        ran = ctx.extras.setdefault("ran", [])
        ran.append(state)
        if state == "baseline":
            self.sm.send("baseline_done")
        elif state == "targeted":
            self.sm.send("targeted_done")

    def route_after(self, state, ctx, summary):
        if state == "triage":
            self.sm.send("triage_done")


def _start(cp):
    return ScanPlaybook(cp).start(session_id=SID, run_id=RID, goal="scan")


def _step(cp, agent, result):
    return ScanPlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def test_start_runs_tool_states_then_dispatches_agent(cp):
    d = _start(cp)
    # Both tool states ran inline; the run lands on the first AGENT state.
    assert d["action"] == "invoke_agent" and d["agent"] == "annie" and d["state_id"] == "triage"
    rec = cp.load(RID)
    assert rec.current_state_id == "triage" and rec.status == STATUS_RUNNING
    assert rec.context.extras["ran"] == ["baseline", "targeted"]


def test_agent_step_completes(cp):
    _start(cp)
    d = _step(cp, "annie", {"triaged": True})
    assert d["action"] == "complete"


def test_tool_state_that_does_not_advance_errors(cp):
    class StuckMachine(ScanMachine):
        pass

    class StuckPlaybook(ScanPlaybook):
        NAME = "stuck-test"

        def run_tool_state(self, state, ctx):
            # Never fires a transition -> engine must fail loud, not loop forever.
            return

    d = StuckPlaybook(cp).start(session_id=SID, run_id=RID, goal="x")
    assert d["action"] == "error"
    assert any("did not advance" in e for e in d["errors"])


def test_mid_tool_crash_recovers_by_rerunning(cp):
    from orchestration import playbooks as pb_mod
    from orchestration.recovery import recover_pending

    # Simulate a crash AT the first tool state: persist status=running there.
    pb = ScanPlaybook(cp)
    from orchestration.context import RunContext

    pb.ctx = RunContext(session_id=SID, run_id=RID, playbook="scan-test")
    pb.sm = ScanMachine()
    pb.sm.current_state_value = "baseline"
    cp.save(
        run_id=RID,
        session_id=SID,
        playbook="scan-test",
        current_state_id="baseline",
        context=pb.ctx,
        status=STATUS_RUNNING,
    )
    orig = dict(pb_mod.PLAYBOOKS)
    pb_mod.PLAYBOOKS["scan-test"] = ScanPlaybook
    try:
        directives = recover_pending(cp, session_id=SID, playbook="scan-test")
    finally:
        pb_mod.PLAYBOOKS.clear()
        pb_mod.PLAYBOOKS.update(orig)
    # Recovery re-drives the tool loop and lands on the agent state.
    assert len(directives) == 1
    assert directives[0]["action"] == "invoke_agent" and directives[0]["state_id"] == "triage"
