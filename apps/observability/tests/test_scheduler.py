"""Tests for the size-based rotation scheduler (C10, C11, C12).

The scheduler no longer runs an age-based cron cleanup. It runs a size-based
rotation once on startup and on a periodic asyncio IntervalTrigger, surfacing
failures via EVENT_JOB_ERROR and an insert_log error row.
"""

import asyncio
from pathlib import Path

import pytest
import pytest_asyncio
from apscheduler.events import EVENT_JOB_ERROR

from observability.db import Database
from observability.scheduler import (
    get_scheduler,
    run_rotation_job,
    start_scheduler,
    stop_scheduler,
)


@pytest_asyncio.fixture
async def db():
    """Yield an in-memory database."""
    database = Database(db_path=Path(":memory:"))
    await database.connect()
    try:
        yield database
    finally:
        await database.close()


@pytest.fixture(autouse=True)
def _reset_scheduler():
    """Guarantee the singleton scheduler is torn down between tests."""
    yield
    try:
        stop_scheduler()
    except Exception:
        pass


@pytest.mark.asyncio
async def test_run_rotation_job_invokes_rotate(db, monkeypatch):
    """run_rotation_job delegates to db.rotate with cap/floor from config."""
    calls: list[tuple] = []

    async def fake_rotate(cap_bytes, floor_bytes, *a, **k):
        calls.append((cap_bytes, floor_bytes))
        return {"triggered": False, "deleted_total": 0}

    monkeypatch.setattr(db, "rotate", fake_rotate)
    await run_rotation_job(db)
    assert len(calls) == 1
    cap, floor = calls[0]
    assert cap > floor > 0


@pytest.mark.asyncio
async def test_c10_startup_rotation_fires(db, monkeypatch):
    """C10: start_scheduler triggers a rotation once on startup."""
    fired: list[Database] = []

    async def fake_job(db):
        fired.append(db)

    monkeypatch.setattr("observability.scheduler.run_rotation_job", fake_job)
    start_scheduler(db)
    # startup rotation is scheduled as a task on the running loop
    await asyncio.sleep(0.15)
    assert fired, "startup rotation should have fired exactly once"
    assert fired[0] is db


@pytest.mark.asyncio
async def test_c11_registers_interval_job_no_cron(db):
    """C11: an IntervalTrigger job is registered and no CronTrigger at hour=3."""
    start_scheduler(db)
    sched = get_scheduler()
    assert sched is not None
    jobs = sched.get_jobs()
    trigger_names = [type(j.trigger).__name__ for j in jobs]
    assert any(name == "IntervalTrigger" for name in trigger_names), trigger_names
    # No cron trigger of any kind (the old 03:00 daily job is retired).
    assert not any(name == "CronTrigger" for name in trigger_names), trigger_names


@pytest.mark.asyncio
async def test_c12_job_error_listener_is_wired(db):
    """C12: an EVENT_JOB_ERROR listener is registered so failures surface."""
    start_scheduler(db)
    sched = get_scheduler()
    masks = [mask for (_cb, mask) in sched._listeners]
    assert any(mask & EVENT_JOB_ERROR for mask in masks), "EVENT_JOB_ERROR must be wired"


@pytest.mark.asyncio
async def test_c12_rotation_failure_is_logged_and_reraised(db, monkeypatch):
    """C12: a rotation failure is written to the logs table and NOT swallowed."""

    async def boom(*a, **k):
        raise RuntimeError("rotate boom")

    monkeypatch.setattr(db, "rotate", boom)

    with pytest.raises(RuntimeError, match="rotate boom"):
        await run_rotation_job(db)

    error_logs, _ = await db.get_logs(level="ERROR")
    assert any(
        "rotation" in (row["event"] or "").lower() for row in error_logs
    ), "rotation failure must be recorded as an ERROR log"


@pytest.mark.asyncio
async def test_scheduler_start_stop(db):
    """Scheduler can be started and stopped without errors."""
    start_scheduler(db)
    sched = get_scheduler()
    assert sched is not None
    assert sched.running
    stop_scheduler()
    await asyncio.sleep(0.05)
    assert not sched.running


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
