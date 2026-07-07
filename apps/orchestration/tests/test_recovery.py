"""Tests for the auto-recovery scan (recover_pending)."""

import pytest

from orchestration.checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_RUNNING,
    Checkpointer,
)
from orchestration.context import RunContext
from orchestration.recovery import recover_pending


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _ctx(run_id, **over):
    base = dict(session_id="s", run_id=run_id, playbook="reference-cycle")
    base.update(over)
    return RunContext(**base)


def test_recovers_running_run_reissues_step(cp):
    cp.save(
        run_id="r-run",
        session_id="s",
        playbook="reference-cycle",
        current_state_id="acting",
        context=_ctx("r-run"),
        status=STATUS_RUNNING,
    )
    directives = recover_pending(cp)
    assert len(directives) == 1
    d = directives[0]
    assert d["action"] == "invoke_agent"
    assert d["state_id"] == "acting" and d["agent"] == "skribble"
    assert d["run_id"] == "r-run"


def test_recovers_awaiting_user_re_presents_escalation(cp):
    ctx = _ctx("r-wait", previous_state="framing", unknown_reason="ambiguous scope")
    cp.save(
        run_id="r-wait",
        session_id="s",
        playbook="reference-cycle",
        current_state_id="awaiting_clarification",
        context=ctx,
        status=STATUS_AWAITING_USER,
    )
    directives = recover_pending(cp)
    assert len(directives) == 1
    d = directives[0]
    assert d["action"] == "escalate_to_user"
    assert d["previous_state"] == "framing"
    assert "ambiguous scope" in d["unknown_reason"]


def test_ignores_terminal_and_unknown_playbook(cp):
    cp.save(
        run_id="r-done",
        session_id="s",
        playbook="reference-cycle",
        current_state_id="complete",
        context=_ctx("r-done"),
        status=STATUS_COMPLETE,
    )
    cp.save(
        run_id="r-bogus",
        session_id="s",
        playbook="does-not-exist",
        current_state_id="acting",
        context=_ctx("r-bogus", playbook="does-not-exist"),
        status=STATUS_RUNNING,
    )
    directives = recover_pending(cp)
    assert directives == []  # terminal ignored, unknown playbook skipped


def test_playbook_scoping_prevents_cross_skill_resume(cp):
    # A pending run of one skill and a recover request for a DIFFERENT skill in
    # the SAME session must NOT resume it (Carren P4 blocking repro). The scope
    # filter compares stored playbook names, so the other name need not resolve.
    cp.save(
        run_id="r-ref",
        session_id="shared",
        playbook="reference-cycle",
        current_state_id="observing",
        context=_ctx("r-ref"),
        status=STATUS_RUNNING,
    )
    # recover scoped to a different skill -> nothing (correct isolation)
    assert recover_pending(cp, session_id="shared", playbook="code") == []
    # recover scoped to reference-cycle -> the run
    d = recover_pending(cp, session_id="shared", playbook="reference-cycle")
    assert len(d) == 1 and d[0]["state_id"] == "observing" and d[0]["agent"] == "echo"
    # unscoped -> still finds it (back-compat)
    assert len(recover_pending(cp, session_id="shared")) == 1


def test_session_scoping(cp):
    cp.save(
        run_id="r-a",
        session_id="sess-a",
        playbook="reference-cycle",
        current_state_id="acting",
        context=_ctx("r-a", session_id="sess-a"),
        status=STATUS_RUNNING,
    )
    cp.save(
        run_id="r-b",
        session_id="sess-b",
        playbook="reference-cycle",
        current_state_id="acting",
        context=_ctx("r-b", session_id="sess-b"),
        status=STATUS_RUNNING,
    )
    assert len(recover_pending(cp, session_id="sess-a")) == 1
    assert len(recover_pending(cp)) == 2
