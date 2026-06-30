"""Unit tests for the SQLite database layer."""

import sys
from pathlib import Path

# Ensure the src/ directory is on the path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest
import pytest_asyncio
from observability.db import Database


@pytest_asyncio.fixture
async def db():
    """Yield an in-memory database, cleaned up after the test."""
    database = Database(db_path=Path(":memory:"))
    await database.connect()
    try:
        yield database
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_connect_initializes_schema(db):
    """Schema tables must exist after connect()."""
    rows = await db._fetchall(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    names = {r[0] for r in rows}
    assert "sessions" in names
    assert "entries" in names
    assert "compactions" in names
    assert "entries_search" in names
    assert "meta" in names


@pytest.mark.asyncio
async def test_upsert_session(db):
    await db.upsert_session(
        session_id="sess-abc",
        cwd="/tmp",
        model_provider="openai",
        model_id="gpt-4o",
        started_at=1_700_000_000,
    )
    sess = await db.get_session("sess-abc")
    assert sess is not None
    assert sess["id"] == "sess-abc"
    assert sess["cwd"] == "/tmp"
    assert sess["model_provider"] == "openai"
    assert sess["entry_count"] == 0


@pytest.mark.asyncio
async def test_close_session(db):
    await db.upsert_session(session_id="sess-abc", started_at=1_700_000_000)
    await db.insert_entry("sess-abc", "message_end", 1_700_000_001, {"role": "user", "content": "hello"})
    await db.insert_entry("sess-abc", "message_end", 1_700_000_002, {"role": "assistant", "content": "hi"})
    await db.close_session("sess-abc", ended_at=1_700_000_010)

    sess = await db.get_session("sess-abc")
    assert sess["ended_at"] == 1_700_000_010
    assert sess["entry_count"] == 2


@pytest.mark.asyncio
async def test_insert_entry_increments_idx(db):
    await db.upsert_session(session_id="sess-abc", started_at=1_700_000_000)
    id1 = await db.insert_entry("sess-abc", "message_end", 1, {"content": "a"})
    id2 = await db.insert_entry("sess-abc", "message_end", 2, {"content": "b"})
    id3 = await db.insert_entry("sess-abc", "tool_result", 3, {"tool": "bash"})

    assert id1 != id2 != id3
    entries, total = await db.get_entries("sess-abc", limit=10)
    assert total == 3
    assert [e["entry_idx"] for e in entries] == [0, 1, 2]


@pytest.mark.asyncio
async def test_list_sessions(db):
    await db.upsert_session("sess-a", started_at=1_700_000_000)
    await db.upsert_session("sess-b", started_at=1_700_000_001)
    items, total = await db.list_sessions(limit=10, offset=0)
    assert total == 2
    assert items[0]["id"] == "sess-b"  # DESC order


@pytest.mark.asyncio
async def test_compaction_crud(db):
    await db.upsert_session("sess-abc", started_at=1_700_000_000)
    artifact = {"schema_version": "1.0.0", "goal": "test", "compaction_seq": 0}
    await db.insert_compaction(
        session_id="sess-abc",
        compaction_seq=0,
        compaction_timestamp="2026-05-04T12:00:00Z",
        artifact=artifact,
        first_kept_entry_id="fk-1",
        tokens_before=15_000,
    )

    items, total = await db.get_compactions("sess-abc")
    assert total == 1
    assert items[0]["compaction_seq"] == 0
    assert items[0]["artifact"]["goal"] == "test"

    single = await db.get_compaction("sess-abc", 0)
    assert single is not None
    assert single["first_kept_entry_id"] == "fk-1"


@pytest.mark.asyncio
async def test_cleanup(db):
    await db.upsert_session("sess-old", started_at=1_700_000_000)
    # Insert an "old" entry with created_at = 0 (far past)
    await db._execute(
        "INSERT INTO entries(session_id, entry_idx, event_type, role, timestamp, data, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("sess-old", 0, "message_end", "user", 1, "{}", 0),
    )
    await db._db.commit()

    result = await db.cleanup(raw_retention_days=1, compaction_retention_days=1)
    assert result["deleted_raw_entries"] == 1
    assert result["deleted_compactions"] == 0

    stats = await db.get_stats()
    assert stats["entry_count"] == 0


@pytest.mark.asyncio
async def test_stats(db):
    await db.upsert_session("sess-1", started_at=1_700_000_000)
    stats = await db.get_stats()
    assert stats["session_count"] == 1
    assert stats["db_size_mb"] >= 0


@pytest.mark.asyncio
async def test_get_entries_event_type_filter(db):
    """event_type parameter filters entries correctly."""
    await db.upsert_session("sess-abc", started_at=1_700_000_000)
    await db.insert_entry("sess-abc", "agent_start", 1, {"agent": "echo"})
    await db.insert_entry("sess-abc", "tool_execution_start", 2, {"toolName": "read"})
    await db.insert_entry("sess-abc", "agent_start", 3, {"agent": "piper"})
    await db.insert_entry("sess-abc", "message_end", 4, {"role": "user", "content": "hi"})

    all_entries, total_all = await db.get_entries("sess-abc")
    assert total_all == 4

    agent_entries, total_agent = await db.get_entries("sess-abc", event_type="agent_start")
    assert total_agent == 2
    assert all(e["event_type"] == "agent_start" for e in agent_entries)

    tool_entries, total_tool = await db.get_entries("sess-abc", event_type="tool_execution_start")
    assert total_tool == 1
    assert tool_entries[0]["data"]["toolName"] == "read"

    msg_entries, total_msg = await db.get_entries("sess-abc", event_type="message_end")
    assert total_msg == 1
    assert msg_entries[0]["event_type"] == "message_end"

    none_entries, total_none = await db.get_entries("sess-abc", event_type="nonexistent")
    assert total_none == 0
    assert none_entries == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
