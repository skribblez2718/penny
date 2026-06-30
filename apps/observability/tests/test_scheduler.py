"""Integration tests for the cleanup scheduler (Phase 6)."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest
import pytest_asyncio
from observability.config import Config
from observability.db import Database
from observability.scheduler import (
    check_startup_emergency_cleanup,
    run_cleanup_job,
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


@pytest.mark.asyncio
async def test_run_cleanup_job_deletes_old_entries(db):
    """Scheduled cleanup should delete raw entries older than retention."""
    # Create a session and an old entry
    await db.upsert_session("sess-old", started_at=1_700_000_000)
    await db.insert_entry("sess-old", "message_end", 1, {"content": "old"})
    # Backdate the entry to be 30 days old
    await db._execute(
        "UPDATE entries SET created_at = 0 WHERE session_id = 'sess-old'"
    )
    await db._db.commit()

    stats_before = await db.get_stats()
    assert stats_before["entry_count"] == 1

    # Run cleanup with 14-day retention (entry at created_at=0 is way older)
    result = await run_cleanup_job(db)
    assert result["deleted_raw_entries"] == 1
    assert result["deleted_compactions"] == 0

    stats_after = await db.get_stats()
    assert stats_after["entry_count"] == 0


@pytest.mark.asyncio
async def test_run_cleanup_job_leaves_fresh_entries(db):
    """Scheduled cleanup should NOT delete entries within retention."""
    await db.upsert_session("sess-fresh", started_at=1_700_000_000)
    await db.insert_entry("sess-fresh", "message_end", 1, {"content": "fresh"})
    # created_at defaults to now, so it's within 14 days

    stats_before = await db.get_stats()
    assert stats_before["entry_count"] == 1

    result = await run_cleanup_job(db)
    assert result["deleted_raw_entries"] == 0
    assert result["deleted_compactions"] == 0

    stats_after = await db.get_stats()
    assert stats_after["entry_count"] == 1


@pytest.mark.asyncio
async def test_check_startup_emergency_cleanup_skips_small_db(db, monkeypatch):
    """Emergency cleanup should NOT run when DB is under threshold."""
    monkeypatch.setattr(Config, "DB_SIZE_MAX_GB", 9999)  # Impossibly high
    result = await check_startup_emergency_cleanup(db)
    assert result is None


@pytest.mark.asyncio
async def test_check_startup_emergency_cleanup_triggers_on_oversized(db, monkeypatch):
    """Emergency cleanup should run when DB exceeds threshold."""
    # Seed enough data to make the DB look oversized.
    # In an in-memory DB we can't fake the file size easily, so we
    # monkeypatch get_stats to report a huge size.
    original_get_stats = db.get_stats

    async def fake_stats():
        stats = await original_get_stats()
        stats["db_size_mb"] = 99999  # ~97 GB
        return stats

    monkeypatch.setattr(db, "get_stats", fake_stats)
    monkeypatch.setattr(Config, "DB_SIZE_MAX_GB", 5)

    # Insert old entries
    await db.upsert_session("sess-big", started_at=1_700_000_000)
    await db.insert_entry("sess-big", "message_end", 1, {"content": "old"})
    await db._execute("UPDATE entries SET created_at = 0 WHERE session_id = 'sess-big'")
    await db._db.commit()

    result = await check_startup_emergency_cleanup(db)
    assert result is not None
    assert result["deleted_raw_entries"] == 1


@pytest.mark.asyncio
async def test_scheduler_start_stop(db):
    """Scheduler can be started and stopped without errors."""
    start_scheduler(db)
    sched = __import__("observability.scheduler", fromlist=["_scheduler"])._scheduler
    assert sched is not None
    assert sched.running
    stop_scheduler()
    # shutdown(wait=False) is async; give the event loop a tick
    await asyncio.sleep(0.05)
    assert not sched.running


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
