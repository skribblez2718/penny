"""Durable checkpointer — SQLite persistence of run state keyed by ``run_id``.

This is the mechanism that retires the legacy state transport: instead of
serializing FSM position onto argv (the legacy state-on-argv transport) or /tmp files and
replaying transitions (the old state-forcing anti-pattern), every run's current_state_id +
``RunContext`` is persisted to a single ``runs`` table. A fresh ``step``
subprocess rehydrates by ``run_id`` — no argv blob, no replay.

Path resolution (first hit wins):
  1. explicit ``db_path`` argument
  2. ``PENNY_ORCH_DB`` env var
  3. ``PROJECT_ROOT`` env var -> ``$PROJECT_ROOT/.penny/orchestration.db``. Orchestration
     state is PENNY-GLOBAL: it always anchors to the Penny project root (.env), NEVER the
     target project a skill happens to operate on. A skill may pass a target ``project_root``
     (a repo under review/build) as the agents' working dir — that must not scatter a
     ``.penny/orchestration.db`` into that tree.
  4. ``<project_root>/.penny/orchestration.db`` (``project_root`` arg or CWD) — last-resort
     fallback used only when ``PROJECT_ROOT`` is unset (e.g. bare unit tests).

The DB is opened per-operation (short-lived connections) so it is safe across
the subprocess boundaries the skill driver creates (start / step / step ...).
WAL mode + a busy timeout allow concurrent readers. See pack
``06-technical-reference.md`` §6.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .context import RunContext

# Run status values (mirrors the observability run status vocabulary).
STATUS_RUNNING = "running"
STATUS_AWAITING_USER = "awaiting_user"
STATUS_COMPLETE = "complete"
STATUS_ERROR = "error"

# Statuses that the auto-recovery scan considers resumable.
PENDING_STATUSES: tuple[str, ...] = (STATUS_RUNNING, STATUS_AWAITING_USER)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id           TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  playbook         TEXT NOT NULL,
  current_state_id TEXT NOT NULL,
  context_json     TEXT NOT NULL,
  status           TEXT NOT NULL,
  created_at       TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_db_path(project_root: str | Path | None) -> Path:
    # 1. explicit override
    env = os.environ.get("PENNY_ORCH_DB")
    if env:
        return Path(env)
    # 2. PENNY-GLOBAL: orchestration state always anchors to the Penny PROJECT_ROOT (.env),
    #    never the target project a skill operates on. This prevents a .penny/orchestration.db
    #    from leaking into a repo passed as a skill's target project_root.
    penny_root = os.environ.get("PROJECT_ROOT")
    if penny_root:
        return Path(penny_root) / ".penny" / "orchestration.db"
    # 3. last-resort fallback (PROJECT_ROOT unset — e.g. bare unit tests)
    root = Path(project_root) if project_root else Path.cwd()
    return root / ".penny" / "orchestration.db"


@dataclass
class CheckpointRecord:
    run_id: str
    session_id: str
    playbook: str
    current_state_id: str
    context: RunContext
    status: str
    created_at: str = ""
    updated_at: str = ""


class Checkpointer:
    def __init__(
        self,
        db_path: str | Path | None = None,
        project_root: str | Path | None = None,
    ) -> None:
        self.db_path: Path = Path(db_path) if db_path else _default_db_path(project_root)
        if str(self.db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # -- connection -------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        if str(self.db_path) != ":memory:":
            conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
            conn.commit()
        finally:
            conn.close()

    # -- persistence ------------------------------------------------------
    def save(
        self,
        *,
        run_id: str,
        session_id: str,
        playbook: str,
        current_state_id: str,
        context: RunContext,
        status: str,
    ) -> None:
        """Upsert a run's state. ``created_at`` is preserved across updates."""
        import json

        now = _now()
        ctx_json = json.dumps(context.to_dict())
        conn = self._connect()
        try:
            conn.execute(
                """
                INSERT INTO runs (run_id, session_id, playbook, current_state_id,
                                  context_json, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    session_id       = excluded.session_id,
                    playbook         = excluded.playbook,
                    current_state_id = excluded.current_state_id,
                    context_json     = excluded.context_json,
                    status           = excluded.status,
                    updated_at       = excluded.updated_at
                """,
                (
                    run_id,
                    session_id,
                    playbook,
                    current_state_id,
                    ctx_json,
                    status,
                    now,
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _row_to_record(self, row: sqlite3.Row) -> CheckpointRecord:
        import json

        ctx = RunContext.from_dict(json.loads(row["context_json"]))
        return CheckpointRecord(
            run_id=row["run_id"],
            session_id=row["session_id"],
            playbook=row["playbook"],
            current_state_id=row["current_state_id"],
            context=ctx,
            status=row["status"],
            created_at=row["created_at"] or "",
            updated_at=row["updated_at"] or "",
        )

    def load(self, run_id: str) -> CheckpointRecord | None:
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            return self._row_to_record(row) if row else None
        finally:
            conn.close()

    def list_pending(self, session_id: str | None = None) -> list[CheckpointRecord]:
        """Return resumable runs (status running/awaiting_user), for the
        auto-recovery scan. Optionally scoped to one session."""
        placeholders = ",".join("?" for _ in PENDING_STATUSES)
        params: list[str] = list(PENDING_STATUSES)
        sql = f"SELECT * FROM runs WHERE status IN ({placeholders})"
        if session_id is not None:
            sql += " AND session_id = ?"
            params.append(session_id)
        sql += " ORDER BY updated_at ASC, rowid ASC"
        conn = self._connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            return [self._row_to_record(r) for r in rows]
        finally:
            conn.close()

    def purge_older_than(self, days: int = 14) -> int:
        """Delete terminal runs (complete/error) older than ``days``. Returns
        the number of rows removed. Pending runs are never purged."""
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        conn = self._connect()
        try:
            cur = conn.execute(
                "DELETE FROM runs WHERE status IN (?, ?) AND updated_at < ?",
                (STATUS_COMPLETE, STATUS_ERROR, cutoff),
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()
