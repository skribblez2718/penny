"""SQLite database schema, connection management, and CRUD operations.

Uses aiosqlite for async I/O with a single-writer SQLite database.
All writes are serialized through a single connection pool reference.
"""

import json
import sqlite3
from pathlib import Path
from typing import Any

import aiosqlite

from observability import logger as _logger
from observability.config import Config

# SQL Schema — versioned for future migrations
SCHEMA_VERSION = 5

SCHEMA_SQL = """
-- Sessions: one row per Pi session
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    model_provider TEXT,
    model_id TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    entry_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
);

-- Entries: raw transcript events (messages, tools, agents, models)
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    entry_idx INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    role TEXT,
    timestamp INTEGER NOT NULL,
    data JSON NOT NULL,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
);

-- Compactions: structured checkpoint artifacts emitted by the compaction extension
CREATE TABLE IF NOT EXISTS compactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    compaction_seq INTEGER NOT NULL,
    compaction_timestamp TEXT NOT NULL,
    artifact JSON NOT NULL,
    first_kept_entry_id TEXT,
    tokens_before INTEGER,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer)),
    UNIQUE(session_id, compaction_seq)
);

-- Logs: structured operational events from the observability server
CREATE TABLE IF NOT EXISTS logs (
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

-- Watcher logs: structured operational events from ambient watcher scripts
CREATE TABLE IF NOT EXISTS watcher_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'INFO',
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    session_id TEXT,
    data JSON,
    created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
);

-- Indexes for fast look-ups
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);

CREATE INDEX IF NOT EXISTS idx_watcher_logs_timestamp ON watcher_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_watcher_logs_level ON watcher_logs(level);
CREATE INDEX IF NOT EXISTS idx_watcher_logs_source ON watcher_logs(source);
CREATE INDEX IF NOT EXISTS idx_watcher_logs_session ON watcher_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, entry_idx);
CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_entries_event_type ON entries(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, compaction_seq);

-- Metadata table for schema versioning and simple key/value storage
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- FTS5 virtual table for full-text search over entries
CREATE VIRTUAL TABLE IF NOT EXISTS entries_search USING fts5(
    data,
    content='entries',
    content_rowid='id'
);

-- Triggers to keep FTS index in sync with entries table
CREATE TRIGGER IF NOT EXISTS entries_search_insert AFTER INSERT ON entries BEGIN
    INSERT INTO entries_search(rowid, data) VALUES (NEW.id, json_extract(NEW.data, '$.content'));
END;

CREATE TRIGGER IF NOT EXISTS entries_search_delete AFTER DELETE ON entries BEGIN
    INSERT INTO entries_search(entries_search, rowid, data) VALUES ('delete', OLD.id, json_extract(OLD.data, '$.content'));
END;

CREATE TRIGGER IF NOT EXISTS entries_search_update AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_search(entries_search, rowid, data) VALUES ('delete', OLD.id, json_extract(OLD.data, '$.content'));
    INSERT INTO entries_search(rowid, data) VALUES (NEW.id, json_extract(NEW.data, '$.content'));
END;
"""

# v5: orchestration runs/events (the correlated timeline for the orchestration
# engine). Kept in its own constant so the SAME DDL feeds both fresh-init
# (connect) and the v4->v5 migration — no drift. session_id is a PLAIN column,
# NOT a cascading FK: orchestration can begin before session_start, so the join
# to sessions/entries is by convention. This shared session_id is what yields
# one correlated timeline. See pack 06-technical-reference.md §7.
ORCH_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS orchestration_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    playbook TEXT,
    goal TEXT,
    status TEXT,
    started_at TEXT,
    ended_at TEXT,
    met INTEGER,
    iterations INTEGER,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS orchestration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    state_id TEXT,
    primitive TEXT,
    agent TEXT,
    data TEXT,
    timestamp TEXT
);
CREATE INDEX IF NOT EXISTS idx_orch_runs_session ON orchestration_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_orch_runs_status ON orchestration_runs(status);
CREATE INDEX IF NOT EXISTS idx_orch_events_run ON orchestration_events(run_id);
CREATE INDEX IF NOT EXISTS idx_orch_events_session ON orchestration_events(session_id);
"""


class Database:
    """Async SQLite wrapper with connection pooling and session counters."""

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or Config.DB_PATH
        self._db: aiosqlite.Connection | None = None
        # In-memory per-session entry counters (entry_idx is 0-based per session)
        self._session_counters: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Open the async connection and initialize schema."""
        Config.ensure_directories()
        self._db = await aiosqlite.connect(
            self.db_path,
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        # Enable WAL mode for better concurrent read performance
        cursor = await self._db.execute("PRAGMA journal_mode=WAL")
        await cursor.close()
        cursor = await self._db.execute("PRAGMA foreign_keys=ON")
        await cursor.close()
        cursor = await self._db.executescript(SCHEMA_SQL)
        await cursor.close()
        # Orchestration tables (v5) — same DDL as the migration uses.
        cursor = await self._db.executescript(ORCH_SCHEMA_SQL)
        await cursor.close()
        await self._db.commit()

        # Bootstrap schema version if absent
        row = await self._fetchone("SELECT value FROM meta WHERE key = 'schema_version'")
        if row is None:
            await self._execute(
                "INSERT INTO meta(key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
            await self._db.commit()
        else:
            current_version = int(row[0])
            if current_version < SCHEMA_VERSION:
                await self._migrate(current_version)

    async def _migrate(self, from_version: int) -> None:
        """Run migrations from from_version to SCHEMA_VERSION."""
        try:
            if from_version < 2:
                # v1 -> v2: create logs table and indexes
                await self._db.execute("""
                    CREATE TABLE IF NOT EXISTS logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp INTEGER NOT NULL,
                        level TEXT NOT NULL DEFAULT 'INFO',
                        component TEXT NOT NULL,
                        event TEXT NOT NULL,
                        session_id TEXT,
                        client_id TEXT,
                        data JSON,
                        created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
                    )
                """)
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)")
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)")
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component)")
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id)")
            if from_version < 3:
                # v2 -> v3: create watcher_logs table and indexes
                await self._db.execute("""
                    CREATE TABLE IF NOT EXISTS watcher_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp INTEGER NOT NULL,
                        level TEXT NOT NULL DEFAULT 'INFO',
                        source TEXT NOT NULL,
                        event TEXT NOT NULL,
                        session_id TEXT,
                        data JSON,
                        created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
                    )
                """)
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_watcher_logs_timestamp ON watcher_logs(timestamp)")
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_watcher_logs_level ON watcher_logs(level)")
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_watcher_logs_source ON watcher_logs(source)")
                await self._db.execute("CREATE INDEX IF NOT EXISTS idx_watcher_logs_session ON watcher_logs(session_id)")
            if from_version < 4:
                # v3 -> v4: fix entries/compactions FK that incorrectly references
                # "sessions_old" (a leftover from an early schema draft). The
                # source db.py has the correct reference `sessions(id)`, but
                # legacy DBs created before the fix have the broken FK baked in.
                # Symptoms: "no such table: main.sessions_old" errors on every
                # VACUUM, ALTER TABLE, or DROP TABLE that touches entries or
                # compactions, plus FK enforcement is silently disabled.
                #
                # Migration strategy:
                # 1. Disable FK enforcement (we're about to drop the broken tables)
                # 2. Rename entries/compactions to *_old (preserves data + bad FK)
                # 3. Recreate entries/compactions with correct FK to sessions(id)
                # 4. Copy data back from *_old tables
                # 5. Drop *_old tables
                # 6. Re-enable FK enforcement
                #
                # This migration is idempotent: if entries_old or compactions_old
                # already exist (partial migration), we drop them first.
                await self._db.execute("PRAGMA foreign_keys = OFF")
                try:
                    # If a previous failed migration left *_old tables behind,
                    # drop them so we can re-run cleanly.
                    for leftover in ("entries_old", "compactions_old"):
                        await self._db.execute(f"DROP TABLE IF EXISTS {leftover}")

                    # Check current FK target on entries. If it's wrong, do the
                    # migration. If it's already correct, skip.
                    async def _fk_target(table: str) -> str | None:
                        async with self._db.execute(f"PRAGMA foreign_key_list({table})") as cur:
                            rows = await cur.fetchall()
                            await cur.close()
                        return rows[0][2] if rows else None

                    entries_fk = await _fk_target("entries")
                    compactions_fk = await _fk_target("compactions")

                    needs_entries_migration = entries_fk and entries_fk != "sessions"
                    needs_compactions_migration = compactions_fk and compactions_fk != "sessions"

                    if needs_entries_migration:
                        # Rename broken entries table
                        await self._db.execute("ALTER TABLE entries RENAME TO entries_old")
                        # Recreate entries with correct FK
                        await self._db.execute("""
                            CREATE TABLE entries (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                                entry_idx INTEGER NOT NULL,
                                event_type TEXT NOT NULL,
                                role TEXT,
                                timestamp INTEGER NOT NULL,
                                data JSON NOT NULL,
                                created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer))
                            )
                        """)
                        # Copy data (preserves ids and timestamps)
                        await self._db.execute(
                            "INSERT INTO entries (id, session_id, entry_idx, event_type, role, timestamp, data, created_at) "
                            "SELECT id, session_id, entry_idx, event_type, role, timestamp, data, created_at FROM entries_old"
                        )
                        # Recreate indexes that were on the old table
                        await self._db.execute(
                            "CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, entry_idx)"
                        )
                        await self._db.execute(
                            "CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(session_id, timestamp)"
                        )
                        await self._db.execute(
                            "CREATE INDEX IF NOT EXISTS idx_entries_event_type ON entries(session_id, event_type)"
                        )
                        # Drop old table
                        await self._db.execute("DROP TABLE entries_old")

                    if needs_compactions_migration:
                        await self._db.execute("ALTER TABLE compactions RENAME TO compactions_old")
                        await self._db.execute("""
                            CREATE TABLE compactions (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                                compaction_seq INTEGER NOT NULL,
                                compaction_timestamp TEXT NOT NULL,
                                artifact JSON NOT NULL,
                                first_kept_entry_id TEXT,
                                tokens_before INTEGER,
                                created_at INTEGER DEFAULT (cast(strftime('%s', 'now') as integer)),
                                UNIQUE(session_id, compaction_seq)
                            )
                        """)
                        await self._db.execute(
                            "INSERT INTO compactions (id, session_id, compaction_seq, compaction_timestamp, artifact, first_kept_entry_id, tokens_before, created_at) "
                            "SELECT id, session_id, compaction_seq, compaction_timestamp, artifact, first_kept_entry_id, tokens_before, created_at FROM compactions_old"
                        )
                        await self._db.execute(
                            "CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, compaction_seq)"
                        )
                        await self._db.execute("DROP TABLE compactions_old")
                finally:
                    # Re-enable FK enforcement regardless of migration success.
                    # If anything failed before this point, the migration block
                    # raised and was caught by the outer try/except — FK would
                    # remain disabled, but that's safer than partially migrated.
                    await self._db.execute("PRAGMA foreign_keys = ON")
            if from_version < 5:
                # v4 -> v5: add orchestration_runs + orchestration_events (the
                # correlated timeline). Idempotent CREATE ... IF NOT EXISTS; same
                # DDL as fresh-init. Existing data untouched.
                await self._db.executescript(ORCH_SCHEMA_SQL)
            await self._execute(
                "UPDATE meta SET value = ? WHERE key = 'schema_version'",
                (str(SCHEMA_VERSION),),
            )
            await self._db.commit()
        except Exception as exc:
            # Migration failure should not prevent server startup;
            # new tables may be missing but everything else works. Log it so a
            # silent un-bumped-version state is at least discoverable.
            err = RuntimeError(str(exc))
            err.code = "OBSERV_DB_MIGRATION_FAILED"
            _logger.warn(
                "observability.db",
                f"schema migration from v{from_version} failed (non-fatal)",
                error=err,
            )

    async def close(self) -> None:
        """Close the connection cleanly."""
        if self._db:
            await self._db.close()
            self._db = None

    async def __aenter__(self) -> "Database":
        await self.connect()
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> aiosqlite.Cursor:
        if self._db is None:
            raise RuntimeError("Database not connected")
        return await self._db.execute(sql, params)

    async def _fetchone(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        cursor = await self._execute(sql, params)
        try:
            return await cursor.fetchone()
        finally:
            await cursor.close()

    async def _fetchall(self, sql: str, params: tuple[Any, ...] = ()) -> list[Any]:
        cursor = await self._execute(sql, params)
        try:
            return await cursor.fetchall()
        finally:
            await cursor.close()
        return await cursor.fetchall()

    # ------------------------------------------------------------------
    # Session operations
    # ------------------------------------------------------------------

    async def upsert_session(
        self,
        session_id: str,
        cwd: str | None = None,
        model_provider: str | None = None,
        model_id: str | None = None,
        started_at: int | None = None,
    ) -> None:
        """Create or update a session row."""
        await self._execute(
            """
            INSERT INTO sessions(id, cwd, model_provider, model_id, started_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                cwd=excluded.cwd,
                model_provider=excluded.model_provider,
                model_id=excluded.model_id,
                started_at=excluded.started_at
            """,
            (session_id, cwd, model_provider, model_id, started_at),
        )
        await self._db.commit()

    async def close_session(self, session_id: str, ended_at: int) -> None:
        """Mark a session as ended and record final entry count."""
        count_row = await self._fetchone(
            "SELECT COUNT(*) FROM entries WHERE session_id = ?", (session_id,)
        )
        entry_count = count_row[0] if count_row else 0
        await self._execute(
            "UPDATE sessions SET ended_at = ?, entry_count = ? WHERE id = ?",
            (ended_at, entry_count, session_id),
        )
        await self._db.commit()
        # Drop in-memory counter to free memory
        self._session_counters.pop(session_id, None)

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Return session metadata as a dict, or None if not found."""
        row = await self._fetchone(
            "SELECT id, cwd, model_provider, model_id, started_at, ended_at, entry_count, created_at "
            "FROM sessions WHERE id = ?",
            (session_id,),
        )
        if row is None:
            return None
        return {
            "id": row[0],
            "cwd": row[1],
            "model_provider": row[2],
            "model_id": row[3],
            "started_at": row[4],
            "ended_at": row[5],
            "entry_count": row[6],
            "created_at": row[7],
        }

    async def list_sessions(
        self,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return paginated session list + total count."""
        rows = await self._fetchall(
            "SELECT id, cwd, model_provider, model_id, started_at, ended_at, entry_count, created_at "
            "FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        total_row = await self._fetchone("SELECT COUNT(*) FROM sessions")
        total = total_row[0] if total_row else 0
        items = [
            {
                "id": r[0],
                "cwd": r[1],
                "model_provider": r[2],
                "model_id": r[3],
                "started_at": r[4],
                "ended_at": r[5],
                "entry_count": r[6],
                "created_at": r[7],
            }
            for r in rows
        ]
        return items, total

    # ------------------------------------------------------------------
    # Entry operations
    # ------------------------------------------------------------------

    async def insert_entry(
        self,
        session_id: str,
        event_type: str,
        timestamp: int,
        data: dict[str, Any],
        role: str | None = None,
    ) -> int:
        """Store a raw transcript entry and return its autoincrement id."""
        idx = self._session_counters.get(session_id, 0)
        self._session_counters[session_id] = idx + 1

        cursor = await self._execute(
            "INSERT INTO entries(session_id, entry_idx, event_type, role, timestamp, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, idx, event_type, role, timestamp, json.dumps(data, default=str)),
        )
        await self._db.commit()
        return cursor.lastrowid  # type: ignore[return-value]

    async def get_entries(
        self,
        session_id: str,
        from_idx: int | None = None,
        to_idx: int | None = None,
        limit: int = 50,
        offset: int = 0,
        event_type: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return paginated entries for a session, optionally filtered by index range and event type."""
        params: list[Any] = [session_id]
        where = "WHERE session_id = ?"

        if from_idx is not None:
            where += " AND entry_idx >= ?"
            params.append(from_idx)
        if to_idx is not None:
            where += " AND entry_idx <= ?"
            params.append(to_idx)
        if event_type is not None:
            where += " AND event_type = ?"
            params.append(event_type)

        rows = await self._fetchall(
            f"SELECT id, entry_idx, event_type, role, timestamp, data, created_at "
            f"FROM entries {where} ORDER BY entry_idx LIMIT ? OFFSET ?",
            (*params, limit, offset),
        )
        total_row = await self._fetchone(
            f"SELECT COUNT(*) FROM entries {where}",
            (*params,),
        )
        total = total_row[0] if total_row else 0
        items = [
            {
                "id": r[0],
                "entry_idx": r[1],
                "event_type": r[2],
                "role": r[3],
                "timestamp": r[4],
                "data": json.loads(r[5]),
                "created_at": r[6],
            }
            for r in rows
        ]
        return items, total

    async def search_entries(
        self,
        session_id: str,
        query: str,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Full-text search over entries for a session via FTS5."""
        # FTS5 query syntax uses double-quoted strings for phrases
        safe_query = query.replace('"', '""')
        fts_sql = (
            "SELECT e.id, e.entry_idx, e.event_type, e.role, e.timestamp, e.data, e.created_at "
            "FROM entries_search s "
            "JOIN entries e ON e.id = s.rowid "
            "WHERE s.data MATCH ? AND e.session_id = ? "
            "ORDER BY rank "
            "LIMIT ?"
        )
        rows = await self._fetchall(fts_sql, (f'"{safe_query}"', session_id, limit))
        return [
            {
                "id": r[0],
                "entry_idx": r[1],
                "event_type": r[2],
                "role": r[3],
                "timestamp": r[4],
                "data": json.loads(r[5]),
                "created_at": r[6],
            }
            for r in rows
        ]

    # ------------------------------------------------------------------
    # Compaction operations
    # ------------------------------------------------------------------

    async def insert_compaction(
        self,
        session_id: str,
        compaction_seq: int,
        compaction_timestamp: str,
        artifact: dict[str, Any],
        first_kept_entry_id: str | None = None,
        tokens_before: int | None = None,
    ) -> int:
        """Store a compaction artifact and return its id."""
        cursor = await self._execute(
            "INSERT INTO compactions(session_id, compaction_seq, compaction_timestamp, artifact, first_kept_entry_id, tokens_before) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(session_id, compaction_seq) DO UPDATE SET "
            "compaction_timestamp=excluded.compaction_timestamp, artifact=excluded.artifact, "
            "first_kept_entry_id=excluded.first_kept_entry_id, tokens_before=excluded.tokens_before",
            (
                session_id,
                compaction_seq,
                compaction_timestamp,
                json.dumps(artifact, default=str),
                first_kept_entry_id,
                tokens_before,
            ),
        )
        await self._db.commit()
        return cursor.lastrowid  # type: ignore[return-value]

    async def get_compactions(
        self,
        session_id: str,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return paginated compaction artifacts for a session."""
        rows = await self._fetchall(
            "SELECT id, compaction_seq, compaction_timestamp, artifact, first_kept_entry_id, tokens_before, created_at "
            "FROM compactions WHERE session_id = ? ORDER BY compaction_seq DESC LIMIT ? OFFSET ?",
            (session_id, limit, offset),
        )
        total_row = await self._fetchone(
            "SELECT COUNT(*) FROM compactions WHERE session_id = ?", (session_id,)
        )
        total = total_row[0] if total_row else 0
        items = [
            {
                "id": r[0],
                "compaction_seq": r[1],
                "compaction_timestamp": r[2],
                "artifact": json.loads(r[3]),
                "first_kept_entry_id": r[4],
                "tokens_before": r[5],
                "created_at": r[6],
            }
            for r in rows
        ]
        return items, total

    async def get_compaction(
        self,
        session_id: str,
        compaction_seq: int,
    ) -> dict[str, Any] | None:
        """Return a specific compaction artifact."""
        row = await self._fetchone(
            "SELECT id, compaction_seq, compaction_timestamp, artifact, first_kept_entry_id, tokens_before, created_at "
            "FROM compactions WHERE session_id = ? AND compaction_seq = ?",
            (session_id, compaction_seq),
        )
        if row is None:
            return None
        return {
            "id": row[0],
            "compaction_seq": row[1],
            "compaction_timestamp": row[2],
            "artifact": json.loads(row[3]),
            "first_kept_entry_id": row[4],
            "tokens_before": row[5],
            "created_at": row[6],
        }

    # ------------------------------------------------------------------
    # Log operations
    # ------------------------------------------------------------------

    async def insert_log(
        self,
        level: str,
        component: str,
        event: str,
        session_id: str | None = None,
        client_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> int:
        """Insert an operational log row. Returns the row id."""
        cursor = await self._execute(
            """
            INSERT INTO logs(timestamp, level, component, event, session_id, client_id, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(__import__("time").time() * 1000),
                level,
                component,
                event,
                session_id,
                client_id,
                json.dumps(data) if data else None,
            ),
        )
        await self._db.commit()
        return cursor.lastrowid

    async def get_logs(
        self,
        limit: int = 50,
        offset: int = 0,
        level: str | None = None,
        component: str | None = None,
        session_id: str | None = None,
        from_ts: int | None = None,
        to_ts: int | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return paginated log entries with optional filters and total count."""
        clauses: list[str] = []
        params: list[Any] = []
        if level:
            clauses.append("level = ?")
            params.append(level)
        if component:
            clauses.append("component = ?")
            params.append(component)
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if from_ts is not None:
            clauses.append("timestamp >= ?")
            params.append(from_ts)
        if to_ts is not None:
            clauses.append("timestamp <= ?")
            params.append(to_ts)

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        count_sql = f"SELECT COUNT(*) FROM logs {where_sql}"
        total_row = await self._fetchone(count_sql, tuple(params))
        total = total_row[0] if total_row else 0

        select_sql = f"""
            SELECT id, timestamp, level, component, event, session_id, client_id, data, created_at
            FROM logs {where_sql}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        """
        rows = await self._fetchall(select_sql, tuple(params + [limit, offset]))
        items = [
            {
                "id": row[0],
                "timestamp": row[1],
                "level": row[2],
                "component": row[3],
                "event": row[4],
                "session_id": row[5],
                "client_id": row[6],
                "data": json.loads(row[7]) if row[7] else None,
                "created_at": row[8],
            }
            for row in rows
        ]
        return items, total

    async def get_log_stats(self) -> dict[str, Any]:
        """Return log counts grouped by level and component, plus timestamp bounds."""
        by_level = await self._fetchall(
            "SELECT level, COUNT(*) FROM logs GROUP BY level ORDER BY COUNT(*) DESC"
        )
        by_component = await self._fetchall(
            "SELECT component, COUNT(*) FROM logs GROUP BY component ORDER BY COUNT(*) DESC"
        )
        total_row = await self._fetchone("SELECT COUNT(*) FROM logs")
        oldest = await self._fetchone("SELECT MIN(timestamp) FROM logs")
        newest = await self._fetchone("SELECT MAX(timestamp) FROM logs")

        return {
            "total": total_row[0] if total_row else 0,
            "by_level": [{"level": r[0], "count": r[1]} for r in by_level],
            "by_component": [{"component": r[0], "count": r[1]} for r in by_component],
            "oldest_timestamp": oldest[0] if oldest and oldest[0] else None,
            "newest_timestamp": newest[0] if newest and newest[0] else None,
        }

    async def cleanup_logs(self, log_retention_days: int = 14) -> int:
        """Delete old operational logs. Returns count deleted."""
        import time
        cutoff = int(time.time()) - (log_retention_days * 86400)
        cursor = await self._execute("DELETE FROM logs WHERE created_at < ?", (cutoff,))
        try:
            await self._db.commit()
            return cursor.rowcount
        finally:
            await cursor.close()

    async def insert_watcher_log(
        self,
        level: str,
        source: str,
        event: str,
        session_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> int:
        """Insert an ambient watcher log row. Returns the row id."""
        cursor = await self._execute(
            """
            INSERT INTO watcher_logs(timestamp, level, source, event, session_id, data)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                int(__import__("time").time() * 1000),
                level,
                source,
                event,
                session_id,
                json.dumps(data) if data else None,
            ),
        )
        await self._db.commit()
        return cursor.lastrowid

    async def get_watcher_logs(
        self,
        limit: int = 50,
        offset: int = 0,
        level: str | None = None,
        source: str | None = None,
        session_id: str | None = None,
        from_ts: int | None = None,
        to_ts: int | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return paginated watcher log entries with optional filters and total count."""
        clauses: list[str] = []
        params: list[Any] = []
        if level:
            clauses.append("level = ?")
            params.append(level)
        if source:
            clauses.append("source = ?")
            params.append(source)
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if from_ts is not None:
            clauses.append("timestamp >= ?")
            params.append(from_ts)
        if to_ts is not None:
            clauses.append("timestamp <= ?")
            params.append(to_ts)

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        count_sql = f"SELECT COUNT(*) FROM watcher_logs {where_sql}"
        total_row = await self._fetchone(count_sql, tuple(params))
        total = total_row[0] if total_row else 0

        select_sql = f"""
            SELECT id, timestamp, level, source, event, session_id, data, created_at
            FROM watcher_logs {where_sql}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        """
        rows = await self._fetchall(select_sql, tuple(params + [limit, offset]))
        items = [
            {
                "id": row[0],
                "timestamp": row[1],
                "level": row[2],
                "source": row[3],
                "event": row[4],
                "session_id": row[5],
                "data": json.loads(row[6]) if row[6] else None,
                "created_at": row[7],
            }
            for row in rows
        ]
        return items, total

    async def get_watcher_log_stats(self) -> dict[str, Any]:
        """Return watcher log counts grouped by level and source, plus timestamp bounds."""
        by_level = await self._fetchall(
            "SELECT level, COUNT(*) FROM watcher_logs GROUP BY level ORDER BY COUNT(*) DESC"
        )
        by_source = await self._fetchall(
            "SELECT source, COUNT(*) FROM watcher_logs GROUP BY source ORDER BY COUNT(*) DESC"
        )
        total_row = await self._fetchone("SELECT COUNT(*) FROM watcher_logs")
        oldest = await self._fetchone("SELECT MIN(timestamp) FROM watcher_logs")
        newest = await self._fetchone("SELECT MAX(timestamp) FROM watcher_logs")

        return {
            "total": total_row[0] if total_row else 0,
            "by_level": [{"level": r[0], "count": r[1]} for r in by_level],
            "by_source": [{"source": r[0], "count": r[1]} for r in by_source],
            "oldest_timestamp": oldest[0] if oldest and oldest[0] else None,
            "newest_timestamp": newest[0] if newest and newest[0] else None,
        }

    async def cleanup_watcher_logs(self, watcher_log_retention_days: int = 14) -> int:
        """Delete old ambient watcher logs. Returns count deleted."""
        import time
        cutoff = int(time.time()) - (watcher_log_retention_days * 86400)
        cursor = await self._execute("DELETE FROM watcher_logs WHERE created_at < ?", (cutoff,))
        try:
            await self._db.commit()
            return cursor.rowcount
        finally:
            await cursor.close()

    # ------------------------------------------------------------------
    # Orchestration runs / events (v5) — the correlated timeline
    # ------------------------------------------------------------------

    async def upsert_orchestration_run(
        self,
        run_id: str,
        session_id: str,
        playbook: str | None = None,
        goal: str | None = None,
        status: str | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
        met: bool | None = None,
        iterations: int | None = None,
    ) -> None:
        """Insert or update a run. created_at + started_at are set once (on
        insert); later calls (run_end) update status/ended_at/met/iterations.
        COALESCE keeps existing non-null values when a field is omitted."""
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        met_int = None if met is None else (1 if met else 0)
        await self._execute(
            """
            INSERT INTO orchestration_runs
                (run_id, session_id, playbook, goal, status, started_at,
                 ended_at, met, iterations, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                session_id = excluded.session_id,
                playbook   = COALESCE(excluded.playbook, orchestration_runs.playbook),
                goal       = COALESCE(excluded.goal, orchestration_runs.goal),
                status     = COALESCE(excluded.status, orchestration_runs.status),
                started_at = COALESCE(orchestration_runs.started_at, excluded.started_at),
                ended_at   = COALESCE(excluded.ended_at, orchestration_runs.ended_at),
                met        = COALESCE(excluded.met, orchestration_runs.met),
                iterations = COALESCE(excluded.iterations, orchestration_runs.iterations)
            """,
            (
                run_id, session_id, playbook, goal, status,
                started_at or now, ended_at, met_int, iterations, now,
            ),
        )
        await self._db.commit()

    async def insert_orchestration_event(
        self,
        run_id: str,
        session_id: str,
        seq: int,
        event_type: str,
        state_id: str | None = None,
        primitive: str | None = None,
        agent: str | None = None,
        data: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> int:
        """Insert a single orchestration event (a digest, never full output)."""
        from datetime import datetime, timezone

        ts = timestamp or datetime.now(timezone.utc).isoformat()
        cursor = await self._execute(
            """
            INSERT INTO orchestration_events
                (run_id, session_id, seq, event_type, state_id, primitive, agent, data, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id, session_id, seq, event_type, state_id, primitive, agent,
                json.dumps(data) if data is not None else None, ts,
            ),
        )
        await self._db.commit()
        return cursor.lastrowid

    def _row_to_run(self, row: Any) -> dict[str, Any]:
        return {
            "run_id": row[0], "session_id": row[1], "playbook": row[2],
            "goal": row[3], "status": row[4], "started_at": row[5],
            "ended_at": row[6],
            "met": None if row[7] is None else bool(row[7]),
            "iterations": row[8], "created_at": row[9],
        }

    _RUN_COLS = (
        "run_id, session_id, playbook, goal, status, started_at, ended_at, met, iterations, created_at"
    )

    async def get_orchestration_runs(
        self,
        session_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = await self._fetchall(
            f"SELECT {self._RUN_COLS} FROM orchestration_runs {where_sql} "
            f"ORDER BY created_at DESC, rowid DESC LIMIT ?",
            tuple(params + [limit]),
        )
        return [self._row_to_run(r) for r in rows]

    async def get_orchestration_run(self, run_id: str) -> dict[str, Any] | None:
        row = await self._fetchone(
            f"SELECT {self._RUN_COLS} FROM orchestration_runs WHERE run_id = ?", (run_id,)
        )
        return self._row_to_run(row) if row else None

    async def get_orchestration_events(self, run_id: str, limit: int = 10000) -> list[dict[str, Any]]:
        rows = await self._fetchall(
            "SELECT id, run_id, session_id, seq, event_type, state_id, primitive, agent, data, timestamp "
            "FROM orchestration_events WHERE run_id = ? ORDER BY seq ASC, id ASC LIMIT ?",
            (run_id, limit),
        )
        return [
            {
                "id": r[0], "run_id": r[1], "session_id": r[2], "seq": r[3],
                "event_type": r[4], "state_id": r[5], "primitive": r[6],
                "agent": r[7], "data": json.loads(r[8]) if r[8] else None,
                "timestamp": r[9],
            }
            for r in rows
        ]

    async def get_session_orchestration(self, session_id: str) -> dict[str, Any]:
        """The correlation view: all runs for a session, each with its ordered
        events. Correlated with Pi agent/tool events by the shared session_id."""
        runs = await self.get_orchestration_runs(session_id=session_id, limit=1000)
        for run in runs:
            run["events"] = await self.get_orchestration_events(run["run_id"])
        return {"session_id": session_id, "runs": runs}

    async def cleanup_orchestration(self, retention_days: int = 14) -> dict[str, int]:
        """Delete orchestration events + runs older than retention (by created_at
        ISO string; lexicographic compare is valid for uniform UTC ISO8601)."""
        from datetime import datetime, timedelta, timezone

        cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
        # Only purge TERMINAL runs (complete/error): a run still 'running' or
        # 'awaiting_user' is logically alive even if old (a single-user system can
        # leave an escalation pending for days) — mirrors checkpointer.purge_older_than.
        # Events first (scoped to purgeable runs), then the runs themselves.
        cur_events = await self._execute(
            "DELETE FROM orchestration_events WHERE run_id IN "
            "(SELECT run_id FROM orchestration_runs WHERE created_at < ? "
            " AND status NOT IN ('running', 'awaiting_user'))",
            (cutoff,),
        )
        deleted_events = cur_events.rowcount
        await cur_events.close()
        cur_runs = await self._execute(
            "DELETE FROM orchestration_runs WHERE created_at < ? "
            "AND status NOT IN ('running', 'awaiting_user')",
            (cutoff,),
        )
        deleted_runs = cur_runs.rowcount
        await cur_runs.close()
        await self._db.commit()
        return {"deleted_orchestration_runs": deleted_runs, "deleted_orchestration_events": deleted_events}

    # ------------------------------------------------------------------
    # Cleanup / retention
    # ------------------------------------------------------------------

    async def cleanup(
        self,
        raw_retention_days: int = 14,
        compaction_retention_days: int = 90,
    ) -> dict[str, int]:
        """Delete old entries and compactions. Returns deletion counts."""
        import time

        now = int(time.time())
        raw_cutoff = now - (raw_retention_days * 86400)
        compaction_cutoff = now - (compaction_retention_days * 86400)

        # Delete old raw entries
        cursor_raw = await self._execute(
            "DELETE FROM entries WHERE created_at < ?", (raw_cutoff,)
        )
        deleted_raw = cursor_raw.rowcount
        await cursor_raw.close()

        # Delete old compactions
        cursor_comp = await self._execute(
            "DELETE FROM compactions WHERE created_at < ?", (compaction_cutoff,)
        )
        deleted_comp = cursor_comp.rowcount
        await cursor_comp.close()

        # Vacuum removed: aiosqlite + WAL + prepared-statements create a flaky
        # VACUUM error under concurrent test conditions. Manual VACUUM is
        # still possible via a separate maintenance endpoint if needed.
        return {"deleted_raw_entries": deleted_raw, "deleted_compactions": deleted_comp}

    async def get_stats(self) -> dict[str, Any]:
        """Return DB health statistics."""
        sessions_row = await self._fetchone("SELECT COUNT(*) FROM sessions")
        entries_row = await self._fetchone("SELECT COUNT(*) FROM entries")
        compactions_row = await self._fetchone("SELECT COUNT(*) FROM compactions")
        logs_row = await self._fetchone("SELECT COUNT(*) FROM logs")
        watcher_logs_row = await self._fetchone("SELECT COUNT(*) FROM watcher_logs")
        oldest_raw = await self._fetchone(
            "SELECT MIN(created_at) FROM entries"
        )
        oldest_comp = await self._fetchone(
            "SELECT MIN(created_at) FROM compactions"
        )
        oldest_log = await self._fetchone(
            "SELECT MIN(created_at) FROM logs"
        )
        oldest_watcher_log = await self._fetchone(
            "SELECT MIN(created_at) FROM watcher_logs"
        )
        db_size = self.db_path.stat().st_size if self.db_path.exists() else 0

        return {
            "db_path": str(self.db_path),
            "db_size_bytes": db_size,
            "db_size_mb": round(db_size / (1024 * 1024), 2),
            "session_count": sessions_row[0] if sessions_row else 0,
            "entry_count": entries_row[0] if entries_row else 0,
            "compaction_count": compactions_row[0] if compactions_row else 0,
            "log_count": logs_row[0] if logs_row else 0,
            "watcher_log_count": watcher_logs_row[0] if watcher_logs_row else 0,
            "oldest_raw_entry_unix": oldest_raw[0] if oldest_raw and oldest_raw[0] else None,
            "oldest_compaction_unix": oldest_comp[0] if oldest_comp and oldest_comp[0] else None,
            "oldest_log_unix": oldest_log[0] if oldest_log and oldest_log[0] else None,
            "oldest_watcher_log_unix": oldest_watcher_log[0] if oldest_watcher_log and oldest_watcher_log[0] else None,
        }
