"""Test the schema migration from v3 (with broken sessions_old FK) to v4.

This simulates the buggy state by manually creating entries and compactions
tables with the bad FK, then verifies the migration recreates them with
the correct FK and preserves all data.
"""

import sqlite3
from pathlib import Path


import pytest
from observability.db import Database, SCHEMA_VERSION
import asyncio
import tempfile
import shutil


@pytest.mark.asyncio
async def test_v3_to_v4_migration():
    """Migrate a v3 database with buggy FK to v4 and verify correctness."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        # Create a v3 database with the buggy FK by running the v3 schema
        # then manually patching the entries/compactions tables to use
        # sessions_old.
        v3_schema_with_bug = """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            model_provider TEXT,
            model_id TEXT,
            started_at INTEGER,
            ended_at INTEGER,
            entry_count INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
        );
        CREATE TABLE entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES "sessions_old"(id) ON DELETE CASCADE,
            entry_idx INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            role TEXT,
            timestamp INTEGER NOT NULL,
            data JSON NOT NULL,
            created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
        );
        CREATE TABLE compactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES "sessions_old"(id) ON DELETE CASCADE,
            compaction_seq INTEGER NOT NULL,
            compaction_timestamp TEXT NOT NULL,
            artifact JSON NOT NULL,
            first_kept_entry_id TEXT,
            tokens_before INTEGER,
            created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer)),
            UNIQUE(session_id, compaction_seq)
        );
        CREATE TABLE logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            level TEXT NOT NULL DEFAULT 'INFO',
            component TEXT NOT NULL,
            event TEXT NOT NULL,
            session_id TEXT,
            client_id TEXT,
            data JSON,
            created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
        );
        CREATE TABLE watcher_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            level TEXT NOT NULL DEFAULT 'INFO',
            source TEXT NOT NULL,
            event TEXT NOT NULL,
            session_id TEXT,
            data JSON,
            created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
        );
        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        INSERT INTO meta(key, value) VALUES ('schema_version', '3');
        INSERT INTO sessions(id) VALUES ('sess-1');
        INSERT INTO sessions(id) VALUES ('sess-2');
        INSERT INTO entries(session_id, entry_idx, event_type, timestamp, data)
            VALUES ('sess-1', 0, 'message', 1000, '{"text": "hello"}');
        INSERT INTO entries(session_id, entry_idx, event_type, timestamp, data)
            VALUES ('sess-1', 1, 'message', 2000, '{"text": "world"}');
        INSERT INTO entries(session_id, entry_idx, event_type, timestamp, data)
            VALUES ('sess-2', 0, 'message', 3000, '{"text": "foo"}');
        INSERT INTO compactions(session_id, compaction_seq, compaction_timestamp, artifact)
            VALUES ('sess-1', 0, '2026-06-08T00:00:00Z', '{"seq": 0}');
        """

        # Bootstrap the buggy DB
        con = sqlite3.connect(str(db_path))
        con.executescript(v3_schema_with_bug)
        con.commit()

        # Verify the bug exists
        fk_list = con.execute("PRAGMA foreign_key_list(entries)").fetchall()
        assert any("sessions_old" in str(fk) for fk in fk_list), \
            "Test setup: entries should reference sessions_old (buggy)"
        con.close()

        # Run the migration by connecting via Database class
        db = Database(db_path=db_path)
        await db.connect()  # This triggers the migration
        await db.close()

        # Verify the bug is gone
        con = sqlite3.connect(str(db_path))
        con.execute("PRAGMA foreign_keys = ON")
        fk_list = con.execute("PRAGMA foreign_key_list(entries)").fetchall()
        fk_table = fk_list[0][2] if fk_list else None
        assert fk_table == "sessions", \
            f"After migration: entries should reference sessions, got {fk_table}"

        fk_list = con.execute("PRAGMA foreign_key_list(compactions)").fetchall()
        fk_table = fk_list[0][2] if fk_list else None
        assert fk_table == "sessions", \
            f"After migration: compactions should reference sessions, got {fk_table}"

        # Verify data preserved
        sess_count = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        entry_count = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        comp_count = con.execute("SELECT COUNT(*) FROM compactions").fetchone()[0]
        assert sess_count == 2, f"Sessions lost: {sess_count} (expected 2)"
        assert entry_count == 3, f"Entries lost: {entry_count} (expected 3)"
        assert comp_count == 1, f"Compactions lost: {comp_count} (expected 1)"

        # Verify schema version bumped
        ver = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
        assert int(ver) == SCHEMA_VERSION, \
            f"Schema version not bumped: {ver} (expected {SCHEMA_VERSION})"

        # Verify _old tables dropped
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        assert "entries_old" not in tables, "entries_old should be dropped after migration"
        assert "compactions_old" not in tables, "compactions_old should be dropped"

        # Verify FK enforcement now works
        # Try inserting an entry with a non-existent session — should fail
        con.execute("PRAGMA foreign_keys = ON")
        try:
            con.execute(
                "INSERT INTO entries(session_id, entry_idx, event_type, timestamp, data) "
                "VALUES ('nonexistent-sess', 99, 'message', 9999, '{}')"
            )
            con.commit()
            assert False, "FK constraint should have rejected nonexistent session_id"
        except sqlite3.IntegrityError as e:
            assert "FOREIGN KEY" in str(e), f"Expected FK error, got: {e}"

        con.close()
        print(f"✓ Migration v3→v{SCHEMA_VERSION} verified:")
        print(f"  - Buggy FK fixed (entries/compactions → sessions)")
        print(f"  - Data preserved (2 sessions, 3 entries, 1 compaction)")
        print(f"  - Schema version bumped to v{SCHEMA_VERSION}")
        print(f"  - _old tables dropped")
        print(f"  - FK enforcement now active (rejected bad insert)")


if __name__ == "__main__":
    # Allow running this test directly (without pytest) for quick verification.
    # pytest is preferred — it handles the async loop correctly.
    asyncio.run(test_v3_to_v4_migration())
