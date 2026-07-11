"""Unit tests for the SQLite database layer."""

from pathlib import Path

# Ensure the src/ directory is on the path

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


# ===========================================================================
# Size-based rotation contract (C3-C9)
# ===========================================================================

# A ~4 KB JSON blob so a handful of rows span multiple SQLite pages. Valid JSON
# with a `.content` field so the entries FTS trigger's json_extract works.
_JSON_BLOB = '{"content":"' + ("x" * 4000) + '"}'


async def _ins_entries(db, n: int, base: int) -> None:
    for i in range(n):
        await db._execute(
            "INSERT INTO entries(session_id, entry_idx, event_type, role, timestamp, data, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            ("s", base + i, "message_end", "user", 1, _JSON_BLOB, base + i),
        )


async def _ins_compactions(db, n: int, base: int) -> None:
    for i in range(n):
        await db._execute(
            "INSERT INTO compactions(session_id, compaction_seq, compaction_timestamp, artifact, "
            "first_kept_entry_id, tokens_before, created_at) VALUES (?,?,?,?,?,?,?)",
            ("s", base + i, "2026-01-01T00:00:00Z", _JSON_BLOB, None, 0, base + i),
        )


async def _ins_logs(db, n: int, base: int) -> None:
    for i in range(n):
        await db._execute(
            "INSERT INTO logs(timestamp, level, component, event, session_id, client_id, data, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (1, "INFO", "c", "e", "s", None, _JSON_BLOB, base + i),
        )


async def _ins_watcher_logs(db, n: int, base: int) -> None:
    for i in range(n):
        await db._execute(
            "INSERT INTO watcher_logs(timestamp, level, source, event, session_id, data, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (1, "INFO", "src", "e", "s", _JSON_BLOB, base + i),
        )


async def _ins_orch_events(db, n: int, base: int) -> None:
    for i in range(n):
        await db._execute(
            "INSERT INTO orchestration_events(run_id, session_id, seq, event_type, state_id, "
            "primitive, agent, data, timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
            (f"run-{base + i}", "s", i, "state_enter", None, None, None, _JSON_BLOB, f"{base + i:020d}"),
        )


async def _ins_orch_runs(db, n: int, base: int) -> None:
    for i in range(n):
        await db._execute(
            "INSERT INTO orchestration_runs(run_id, session_id, playbook, goal, status, started_at, "
            "ended_at, met, iterations, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (f"orun-{base + i}", "s", "pb", _JSON_BLOB, "complete", None, None, 1, 1, f"{base + i:020d}"),
        )


@pytest.mark.asyncio
async def test_get_stats_reports_live_and_file_bytes(db):
    """get_stats() exposes live_bytes and file_bytes (SC-2)."""
    stats = await db.get_stats()
    assert "live_bytes" in stats
    assert "file_bytes" in stats
    assert stats["file_bytes"] >= stats["live_bytes"] >= 0


@pytest.mark.asyncio
async def test_c3_live_bytes_drops_file_bytes_constant_after_delete(db):
    """C3: after a delete WITHOUT vacuum, live_bytes drops but file_bytes holds."""
    await _ins_logs(db, 400, 1)
    await db._db.commit()
    file_before = await db.file_bytes()
    live_before = await db.live_bytes()
    assert file_before == (await db._fetchone("PRAGMA page_count"))[0] * (
        await db._fetchone("PRAGMA page_size")
    )[0]

    cur = await db._execute("DELETE FROM logs WHERE created_at <= 200")
    await cur.close()
    await db._db.commit()

    live_after = await db.live_bytes()
    file_after = await db.file_bytes()
    assert live_after < live_before, "live_bytes must shrink after delete"
    assert file_after == file_before, "file_bytes must not shrink without vacuum"


@pytest.mark.asyncio
async def test_c4_rotate_deletes_oldest_across_all_tables(db):
    """C4: rotate() evicts oldest-first from EVERY table, compactions included."""
    await db.upsert_session("s", started_at=1)
    old_n, new_n, new_base = 200, 5, 10_000_000
    for ins in (
        _ins_entries,
        _ins_compactions,
        _ins_logs,
        _ins_watcher_logs,
        _ins_orch_events,
        _ins_orch_runs,
    ):
        await ins(db, old_n, 1)
        await ins(db, new_n, new_base)
    await db._db.commit()

    file_before = await db.file_bytes()
    live_before = await db.live_bytes()
    result = await db.rotate(
        cap_bytes=file_before, floor_bytes=int(live_before * 0.75), batch_size=50
    )
    assert result["triggered"] is True

    # (table, order_column, oldest_value, newest_value)
    newest = new_base + new_n - 1
    checks = [
        ("entries", "created_at", 1, newest),
        ("compactions", "created_at", 1, newest),
        ("logs", "created_at", 1, newest),
        ("watcher_logs", "created_at", 1, newest),
        ("orchestration_events", "timestamp", f"{1:020d}", f"{newest:020d}"),
        ("orchestration_runs", "created_at", f"{1:020d}", f"{newest:020d}"),
    ]
    for table, col, oldest_val, newest_val in checks:
        gone = await db._fetchone(
            f"SELECT COUNT(*) FROM {table} WHERE {col} = ?", (oldest_val,)
        )
        assert gone[0] == 0, f"{table}: oldest row must be evicted"
        kept = await db._fetchone(
            f"SELECT COUNT(*) FROM {table} WHERE {col} = ?", (newest_val,)
        )
        assert kept[0] == 1, f"{table}: newest row must be retained"


@pytest.mark.asyncio
async def test_c5_rotate_over_cap_drains_live_to_floor(db):
    """C5: on a DB whose file_bytes>=cap, rotate() drives live_bytes<=floor."""
    await _ins_logs(db, 600, 1)
    await db._db.commit()
    file_before = await db.file_bytes()
    live_before = await db.live_bytes()
    floor = live_before // 3
    result = await db.rotate(cap_bytes=file_before, floor_bytes=floor, batch_size=50)
    assert result["triggered"] is True
    live_after = await db.live_bytes()
    assert live_after <= floor


@pytest.mark.asyncio
async def test_c5_rotate_under_cap_is_noop(db):
    """rotate() does nothing when file_bytes < cap."""
    await _ins_logs(db, 10, 1)
    await db._db.commit()
    file_before = await db.file_bytes()
    result = await db.rotate(cap_bytes=file_before * 100, floor_bytes=1, batch_size=50)
    assert result["triggered"] is False
    row = await db._fetchone("SELECT COUNT(*) FROM logs")
    assert row[0] == 10


@pytest.mark.asyncio
async def test_c6_rotate_keeps_newest_rows(db):
    """C6: rotation never deletes newest rows while older rows exist."""
    await db.upsert_session("s", started_at=1)
    await _ins_entries(db, 200, 1)
    await _ins_entries(db, 10, 10_000_000)
    await db._db.commit()
    file_before = await db.file_bytes()
    live_before = await db.live_bytes()
    result = await db.rotate(
        cap_bytes=file_before, floor_bytes=int(live_before * 0.75), batch_size=50
    )
    assert result["triggered"] is True
    survivors = await db._fetchone(
        "SELECT COUNT(*) FROM entries WHERE created_at >= 10000000"
    )
    assert survivors[0] == 10, "the newest 10 rows must survive"
    oldest = await db._fetchone("SELECT COUNT(*) FROM entries WHERE created_at = 1")
    assert oldest[0] == 0, "the oldest row must be evicted"


@pytest.mark.asyncio
async def test_c7_rotate_issues_no_vacuum(db):
    """C7: no VACUUM statement is executed anywhere in the rotation path."""
    await _ins_logs(db, 300, 1)
    await db._db.commit()
    executed: list[str] = []
    orig_execute = db._execute

    async def _spy(sql, params=()):
        executed.append(sql)
        return await orig_execute(sql, params)

    db._execute = _spy
    file_before = await db.file_bytes()
    live_before = await db.live_bytes()
    await db.rotate(cap_bytes=file_before, floor_bytes=live_before // 2, batch_size=50)
    assert executed, "rotate must execute SQL"
    assert not any("vacuum" in sql.lower() for sql in executed), "no VACUUM allowed"


@pytest.mark.asyncio
async def test_c8_page_reuse_no_growth_beyond_cap(db):
    """C8: after rotate(), new inserts reuse freed pages; file_bytes stays <= cap."""
    await _ins_logs(db, 400, 1)
    await db._db.commit()
    file_s = await db.file_bytes()
    live_s = await db.live_bytes()
    cap = file_s
    result = await db.rotate(cap_bytes=cap, floor_bytes=live_s // 2)
    assert result["triggered"] is True
    file_after_rotate = await db.file_bytes()
    assert file_after_rotate == file_s, "file must not shrink (no vacuum)"
    # Refill with fewer bytes than were freed -> reuse the freelist, no growth.
    await _ins_logs(db, 150, 20_000_000)
    await db._db.commit()
    file_final = await db.file_bytes()
    assert file_final <= cap, "refill must reuse freed pages, not grow past cap"


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_c9_rotate_terminates_on_unreachable_floor(db):
    """C9: an unreachable floor terminates via the bounded iteration guard."""
    await _ins_logs(db, 50, 1)
    await db._db.commit()
    # floor of 1 byte can never be reached (schema base pages alone exceed it).
    result = await db.rotate_to_floor(floor_bytes=1, batch_size=10)
    assert isinstance(result, dict)
    assert result["iterations"] < 100_000, "must not spin unbounded"
    live_after = await db.live_bytes()
    assert live_after > 1, "floor is genuinely unreachable, yet rotation returned"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
