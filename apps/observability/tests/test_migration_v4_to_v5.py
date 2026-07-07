"""Test the schema migration from v4 to v5 (adds orchestration tables).

Builds a minimal v4 database (no orchestration tables) with some existing
session/entry/log data, then connects via the Database class to trigger the
v4->v5 migration and verifies the orchestration tables now exist and all
pre-existing data is intact.
"""

import asyncio
import sqlite3
import tempfile
from pathlib import Path

import pytest

from observability.db import SCHEMA_VERSION, Database

_V4_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, model_provider TEXT, model_id TEXT,
    started_at INTEGER, ended_at INTEGER, entry_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
);
CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    entry_idx INTEGER NOT NULL, event_type TEXT NOT NULL, role TEXT,
    timestamp INTEGER NOT NULL, data JSON NOT NULL,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
);
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'INFO', component TEXT NOT NULL, event TEXT NOT NULL,
    session_id TEXT, client_id TEXT, data JSON,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta(key, value) VALUES ('schema_version', '4');
INSERT INTO sessions(id) VALUES ('sess-1');
INSERT INTO entries(session_id, entry_idx, event_type, timestamp, data)
    VALUES ('sess-1', 0, 'message', 1000, '{"text": "hello"}');
INSERT INTO entries(session_id, entry_idx, event_type, timestamp, data)
    VALUES ('sess-1', 1, 'message', 2000, '{"text": "world"}');
INSERT INTO logs(timestamp, level, component, event) VALUES (1000, 'INFO', 'server', 'boot');
"""


@pytest.mark.asyncio
async def test_v4_to_v5_migration():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"

        con = sqlite3.connect(str(db_path))
        con.executescript(_V4_SCHEMA)
        con.commit()
        # v4 has no orchestration tables.
        tables_before = {
            r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "orchestration_runs" not in tables_before
        assert "orchestration_events" not in tables_before
        con.close()

        # Connect via Database -> triggers v4->v5 migration.
        db = Database(db_path=db_path)
        await db.connect()
        await db.close()

        con = sqlite3.connect(str(db_path))
        tables_after = {
            r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "orchestration_runs" in tables_after
        assert "orchestration_events" in tables_after

        # Pre-existing data intact.
        assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 2
        assert con.execute("SELECT COUNT(*) FROM logs").fetchone()[0] == 1

        # Version bumped.
        ver = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
        assert int(ver) == SCHEMA_VERSION == 5

        # Orchestration indexes present.
        indexes = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert "idx_orch_events_run" in indexes
        assert "idx_orch_events_session" in indexes
        con.close()


if __name__ == "__main__":
    asyncio.run(test_v4_to_v5_migration())
