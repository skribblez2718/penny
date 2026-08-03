"""Unit tests for the observability logs table and CRUD operations."""

import time
from pathlib import Path

import pytest
import pytest_asyncio

from observability.db import Database


@pytest_asyncio.fixture(loop_scope="function")
async def db(tmp_path: Path):
    """Yield an in-memory Database instance, cleaned up after each test."""
    db_path = tmp_path / "test.db"
    database = Database(db_path)
    await database.connect()
    yield database
    await database.close()


@pytest.mark.asyncio
async def test_logs_table_exists(db: Database) -> None:
    row = await db._fetchone(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='logs'"
    )
    assert row is not None
    assert row[0] == "logs"


@pytest.mark.asyncio
async def test_schema_version_is_3(db: Database) -> None:
    """Schema version must match the SCHEMA_VERSION constant in db.py.

    Bug fix 2026-06-08: was hard-coded to 3, but we bumped to 4 for the
    v3->v4 migration that fixes the broken sessions_old FK reference.
    """
    from observability.db import SCHEMA_VERSION
    row = await db._fetchone(
        "SELECT value FROM meta WHERE key = 'schema_version'"
    )
    assert row is not None
    assert int(row[0]) == SCHEMA_VERSION


@pytest.mark.asyncio
async def test_insert_log(db: Database) -> None:
    log_id = await db.insert_log(
        level="INFO",
        component="test",
        event="test_event",
        session_id="sess-001",
        client_id="client-001",
        data={"foo": "bar"},
    )
    assert isinstance(log_id, int)
    assert log_id > 0


@pytest.mark.asyncio
async def test_get_logs_returns_inserted(db: Database) -> None:
    await db.insert_log("INFO", "server", "hello", data={"key": "val"})
    items, total = await db.get_logs(limit=10, offset=0)
    assert total == 1
    assert len(items) == 1
    assert items[0]["level"] == "INFO"
    assert items[0]["component"] == "server"
    assert items[0]["event"] == "hello"
    assert items[0]["data"] == {"key": "val"}


@pytest.mark.asyncio
async def test_get_logs_pagination(db: Database) -> None:
    for i in range(5):
        await db.insert_log("INFO", "server", f"evt-{i}")
    items, total = await db.get_logs(limit=2, offset=0)
    assert total == 5
    assert len(items) == 2
    items, total = await db.get_logs(limit=2, offset=2)
    assert len(items) == 2
    items, total = await db.get_logs(limit=2, offset=4)
    assert len(items) == 1


@pytest.mark.asyncio
async def test_get_logs_filter_by_level(db: Database) -> None:
    await db.insert_log("INFO", "server", "info_event")
    await db.insert_log("ERROR", "server", "error_event")
    items, total = await db.get_logs(level="ERROR")
    assert total == 1
    assert items[0]["event"] == "error_event"


@pytest.mark.asyncio
async def test_get_logs_filter_by_component(db: Database) -> None:
    await db.insert_log("INFO", "server", "srv_event")
    await db.insert_log("INFO", "scheduler", "sch_event")
    items, total = await db.get_logs(component="scheduler")
    assert total == 1
    assert items[0]["event"] == "sch_event"


@pytest.mark.asyncio
async def test_get_logs_filter_by_session_id(db: Database) -> None:
    await db.insert_log("INFO", "server", "a", session_id="sess-1")
    await db.insert_log("INFO", "server", "b", session_id="sess-2")
    items, total = await db.get_logs(session_id="sess-1")
    assert total == 1
    assert items[0]["event"] == "a"


@pytest.mark.asyncio
async def test_get_logs_filter_by_timestamp_range(db: Database) -> None:
    now = int(time.time() * 1000)
    await db.insert_log("INFO", "server", "old")
    await db.insert_log("INFO", "server", "new")
    items, total = await db.get_logs(from_ts=now - 1000)
    assert total >= 1


@pytest.mark.asyncio
async def test_get_log_stats(db: Database) -> None:
    await db.insert_log("INFO", "server", "e1")
    await db.insert_log("ERROR", "server", "e2")
    await db.insert_log("INFO", "scheduler", "e3")
    stats = await db.get_log_stats()
    assert stats["total"] == 3
    levels = {r["level"]: r["count"] for r in stats["by_level"]}
    assert levels.get("INFO") == 2
    assert levels.get("ERROR") == 1
    components = {r["component"]: r["count"] for r in stats["by_component"]}
    assert components.get("server") == 2
    assert components.get("scheduler") == 1


@pytest.mark.asyncio
async def test_cleanup_logs(db: Database) -> None:
    now_sec = int(time.time())
    await db._execute(
        "INSERT INTO logs(timestamp, level, component, event, created_at) VALUES (?, ?, ?, ?, ?)",
        (now_sec * 1000, "INFO", "server", "old", now_sec - 100 * 86400),
    )
    await db._db.commit()
    deleted = await db.cleanup_logs(log_retention_days=14)
    assert deleted == 1
    items, total = await db.get_logs()
    assert total == 0


@pytest.mark.asyncio
async def test_cleanup_logs_signature_unchanged(db: Database) -> None:
    import inspect
    sig = inspect.signature(db.cleanup)
    params = list(sig.parameters.keys())
    assert "raw_retention_days" in params
    assert "compaction_retention_days" in params
    assert "log_retention_days" not in params


@pytest.mark.asyncio
async def test_cleanup_logs_separate_method(db: Database) -> None:
    assert callable(db.cleanup_logs)


@pytest.mark.asyncio
async def test_get_stats_includes_log_fields(db: Database) -> None:
    stats = await db.get_stats()
    assert "log_count" in stats
    assert "oldest_log_unix" in stats
    assert stats["log_count"] == 0
    assert stats["oldest_log_unix"] is None


@pytest.mark.asyncio
async def test_get_stats_with_logs(db: Database) -> None:
    await db.insert_log("INFO", "server", "evt")
    stats = await db.get_stats()
    assert stats["log_count"] == 1
