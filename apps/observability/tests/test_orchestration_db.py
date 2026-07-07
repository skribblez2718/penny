"""DB-layer tests for orchestration runs/events retention (cleanup_orchestration).

Focus: the status guard — old TERMINAL runs are purged, old PENDING runs
(running / awaiting_user) are preserved even when past the retention window.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio

from observability.db import Database


@pytest_asyncio.fixture
async def db(tmp_path: Path):
    database = Database(db_path=tmp_path / "orch-db.db")
    await database.connect()
    try:
        yield database
    finally:
        await database.close()


async def _backdate(db: Database, run_id: str, days: int) -> None:
    old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    await db._execute("UPDATE orchestration_runs SET created_at = ? WHERE run_id = ?", (old, run_id))
    await db._db.commit()


@pytest.mark.asyncio
async def test_cleanup_purges_old_terminal_preserves_old_pending(db: Database):
    # Four runs, all backdated 30 days.
    for rid, status in [
        ("old-complete", "complete"),
        ("old-error", "error"),
        ("old-running", "running"),
        ("old-awaiting", "awaiting_user"),
    ]:
        await db.upsert_orchestration_run(run_id=rid, session_id="s", playbook="p", status=status)
        await db.insert_orchestration_event(rid, "s", 1, "run_start")
        await _backdate(db, rid, 30)

    # A fresh terminal run must survive (not old enough).
    await db.upsert_orchestration_run(run_id="fresh-complete", session_id="s", status="complete")

    result = await db.cleanup_orchestration(retention_days=14)
    assert result["deleted_orchestration_runs"] == 2  # only old complete + error

    remaining = {r["run_id"] for r in await db.get_orchestration_runs(limit=100)}
    assert remaining == {"old-running", "old-awaiting", "fresh-complete"}

    # Events of purged runs are gone; events of preserved runs remain.
    assert await db.get_orchestration_events("old-complete") == []
    assert len(await db.get_orchestration_events("old-running")) == 1


@pytest.mark.asyncio
async def test_upsert_coalesce_preserves_start_fields(db: Database):
    await db.upsert_orchestration_run(
        run_id="r", session_id="s", playbook="reference-cycle", goal="g", status="running"
    )
    # run_end style update omits playbook/goal.
    await db.upsert_orchestration_run(
        run_id="r", session_id="s", status="complete", met=True, iterations=3,
        ended_at="2026-07-03T00:00:00+00:00",
    )
    run = await db.get_orchestration_run("r")
    assert run["playbook"] == "reference-cycle"  # preserved via COALESCE
    assert run["goal"] == "g"
    assert run["status"] == "complete"
    assert run["met"] is True
    assert run["iterations"] == 3
    assert run["started_at"]  # set on first insert, preserved
