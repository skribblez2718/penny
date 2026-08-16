"""Tests for the auto-recovery scan (recover_pending)."""

import pytest

from orchestration.checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_RUNNING,
    Checkpointer,
)
from orchestration.context import RunContext
from orchestration.recovery import recover_pending, recover_run


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


def test_scan_ignores_terminal_and_surfaces_unknown_playbook_tombstone(cp):
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
    assert len(directives) == 1
    tombstone = directives[0]
    assert tombstone["action"] == "error"
    assert tombstone["code"] == "PLAYBOOK_UNAVAILABLE"
    assert tombstone["playbook"] == "does-not-exist"
    assert cp.load("r-bogus").status == STATUS_RUNNING


def test_exact_recover_uses_run_id_not_first_session_match(cp):
    for run_id, state in (("r-first", "observing"), ("r-target", "acting")):
        cp.save(
            run_id=run_id,
            session_id="shared",
            playbook="reference-cycle",
            current_state_id=state,
            context=_ctx(run_id, session_id="shared"),
            status=STATUS_RUNNING,
        )
    directive = recover_run(
        cp,
        run_id="r-target",
        session_id="shared",
        playbook="reference-cycle",
    )
    assert directive["run_id"] == "r-target"
    assert directive["state_id"] == "acting"


def test_exact_recover_rejects_identity_mismatch(cp):
    cp.save(
        run_id="r-target",
        session_id="stored-session",
        playbook="reference-cycle",
        current_state_id="acting",
        context=_ctx("r-target", session_id="stored-session"),
        status=STATUS_RUNNING,
    )
    mismatch = recover_run(
        cp,
        run_id="r-target",
        session_id="other-session",
        playbook="reference-cycle",
    )
    assert mismatch["action"] == "error"
    assert "immutable identity" in mismatch["errors"][0]
    assert cp.load("r-target").current_state_id == "acting"


def test_playbook_scoping_prevents_cross_skill_resume(cp):
    # A pending run of one skill and a recover request for a DIFFERENT skill in
    # the SAME session must NOT resume it (Carren P4 blocking repro). The scope
    # filter compares stored playbook names, so the other name need not resolve.
    cp.save(
        run_id="r-ref",
        session_id="shared",
        playbook="reference-cycle",
        current_state_id="observing",
        context=_ctx("r-ref", session_id="shared"),
        status=STATUS_RUNNING,
    )
    # recover scoped to a different skill -> nothing (correct isolation)
    assert recover_pending(cp, session_id="shared", playbook="research") == []
    # recover scoped to reference-cycle -> the run
    d = recover_pending(cp, session_id="shared", playbook="reference-cycle")
    assert len(d) == 1 and d[0]["state_id"] == "observing" and d[0]["agent"] == "echo"
    # unscoped -> still finds it (back-compat)
    assert len(recover_pending(cp, session_id="shared")) == 1


def test_errored_run_is_not_auto_recovered_but_opt_in_redrives_failed_phase(cp):
    # F2: an error run carries its failed phase in ctx.extras['failed_state'].
    ctx = _ctx("r-err")
    ctx.extras["failed_state"] = "acting"
    cp.save(
        run_id="r-err",
        session_id="s",
        playbook="reference-cycle",
        current_state_id="error",
        context=ctx,
        status=STATUS_ERROR,
    )
    # Default scan NEVER auto-retries an error run.
    assert recover_pending(cp) == []
    # Opt-in explicitly re-drives the FAILED phase (not a restart).
    d = recover_pending(cp, include_errored=True)
    assert len(d) == 1
    assert d[0]["action"] == "invoke_agent"
    assert d[0]["state_id"] == "acting" and d[0]["agent"] == "skribble"
    assert d[0]["run_id"] == "r-err"


def test_errored_run_without_failed_state_is_actionable_even_opt_in(cp):
    # An exact surfaced error is preferable to silently hiding a stranded run.
    cp.save(
        run_id="r-err2",
        session_id="s",
        playbook="reference-cycle",
        current_state_id="error",
        context=_ctx("r-err2"),
        status=STATUS_ERROR,
    )
    directives = recover_pending(cp, include_errored=True)
    assert len(directives) == 1
    assert directives[0]["action"] == "error"
    assert "no recoverable" in directives[0]["errors"][0]


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
