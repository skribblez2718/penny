"""Tests for orchestration.checkpointer — durable, resume-by-run_id state.

The headline guarantee (§6): save mid-flow, then load in a FRESH Checkpointer
object (a new process would do the same) returns an identical context + state
id — no argv blob, no transition replay.
"""

import time
from datetime import datetime, timedelta, timezone

import pytest

from orchestration.checkpointer import (
    STATUS_AWAITING_USER,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_RUNNING,
    Checkpointer,
)
from orchestration.context import RunContext


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "orchestration.db"


def _ctx(run_id="run-1", **over) -> RunContext:
    base = dict(session_id="sess-1", run_id=run_id, playbook="reference-cycle")
    base.update(over)
    return RunContext(**base)


def test_save_then_load_in_fresh_object(db_path):
    cp = Checkpointer(db_path=db_path)
    ctx = _ctx(goal="ship it", success_criteria=["c1"], iteration=2, verify_verdict="FAIL")
    cp.save(
        run_id="run-1",
        session_id="sess-1",
        playbook="reference-cycle",
        current_state_id="verifying",
        context=ctx,
        status=STATUS_RUNNING,
    )

    # Fresh object == what a new step subprocess sees.
    cp2 = Checkpointer(db_path=db_path)
    rec = cp2.load("run-1")
    assert rec is not None
    assert rec.current_state_id == "verifying"
    assert rec.status == STATUS_RUNNING
    assert rec.context == ctx  # identical RunContext round-trip


def test_load_missing_returns_none(db_path):
    cp = Checkpointer(db_path=db_path)
    assert cp.load("nope") is None


def test_upsert_preserves_created_at_updates_updated_at(db_path):
    cp = Checkpointer(db_path=db_path)
    cp.save(
        run_id="run-1",
        session_id="s",
        playbook="p",
        current_state_id="framing",
        context=_ctx(),
        status=STATUS_RUNNING,
    )
    first = cp.load("run-1")
    time.sleep(0.01)
    cp.save(
        run_id="run-1",
        session_id="s",
        playbook="p",
        current_state_id="acting",
        context=_ctx(iteration=1),
        status=STATUS_RUNNING,
    )
    second = cp.load("run-1")
    assert second.created_at == first.created_at
    assert second.updated_at >= first.updated_at
    assert second.current_state_id == "acting"


def test_list_pending_only_resumable(db_path):
    cp = Checkpointer(db_path=db_path)
    cp.save(
        run_id="r-run",
        session_id="s",
        playbook="p",
        current_state_id="acting",
        context=_ctx(run_id="r-run"),
        status=STATUS_RUNNING,
    )
    cp.save(
        run_id="r-wait",
        session_id="s",
        playbook="p",
        current_state_id="awaiting_clarification",
        context=_ctx(run_id="r-wait"),
        status=STATUS_AWAITING_USER,
    )
    cp.save(
        run_id="r-done",
        session_id="s",
        playbook="p",
        current_state_id="complete",
        context=_ctx(run_id="r-done"),
        status=STATUS_COMPLETE,
    )
    cp.save(
        run_id="r-err",
        session_id="s",
        playbook="p",
        current_state_id="error",
        context=_ctx(run_id="r-err"),
        status=STATUS_ERROR,
    )
    pending = {r.run_id for r in cp.list_pending()}
    assert pending == {"r-run", "r-wait"}
    # session scoping
    assert {r.run_id for r in cp.list_pending(session_id="s")} == {"r-run", "r-wait"}
    assert cp.list_pending(session_id="nope") == []


def test_purge_older_than_only_terminal(db_path, monkeypatch):
    cp = Checkpointer(db_path=db_path)
    # Insert rows, then rewrite updated_at to be old for two of them.
    cp.save(
        run_id="old-done",
        session_id="s",
        playbook="p",
        current_state_id="complete",
        context=_ctx(run_id="old-done"),
        status=STATUS_COMPLETE,
    )
    cp.save(
        run_id="old-run",
        session_id="s",
        playbook="p",
        current_state_id="acting",
        context=_ctx(run_id="old-run"),
        status=STATUS_RUNNING,
    )
    cp.save(
        run_id="fresh-done",
        session_id="s",
        playbook="p",
        current_state_id="complete",
        context=_ctx(run_id="fresh-done"),
        status=STATUS_COMPLETE,
    )

    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    conn = cp._connect()
    try:
        conn.execute(
            "UPDATE runs SET updated_at = ? WHERE run_id IN ('old-done','old-run')", (old,)
        )
        conn.commit()
    finally:
        conn.close()

    removed = cp.purge_older_than(days=14)
    assert removed == 1  # only old-done (terminal + old); old-run is pending
    assert cp.load("old-done") is None
    assert cp.load("old-run") is not None  # pending never purged
    assert cp.load("fresh-done") is not None


def test_default_path_uses_env(tmp_path, monkeypatch):
    target = tmp_path / "custom" / "orch.db"
    monkeypatch.setenv("PENNY_ORCH_DB", str(target))
    cp = Checkpointer()
    assert cp.db_path == target
    assert target.parent.exists()  # parent dir created


def test_default_path_uses_project_root(tmp_path, monkeypatch):
    monkeypatch.delenv("PENNY_ORCH_DB", raising=False)
    cp = Checkpointer(project_root=tmp_path)
    assert cp.db_path == tmp_path / ".penny" / "orchestration.db"
