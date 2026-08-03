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

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id      TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  version          INTEGER NOT NULL CHECK(version > 0),
  schema_version   INTEGER NOT NULL CHECK(schema_version > 0),
  envelope_json    TEXT NOT NULL,
  envelope_digest  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE(run_id, kind, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_kind ON artifacts(run_id, kind);

CREATE TABLE IF NOT EXISTS artifact_selections (
  run_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK(version > 0),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY(run_id, kind),
  FOREIGN KEY(artifact_id) REFERENCES artifacts(artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_selections_artifact
  ON artifact_selections(artifact_id);
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
            if self.db_path.parent.is_symlink():
                raise PermissionError("orchestration database directory cannot be a symlink")
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._harden_database_files()
        self._init_schema()

    def _harden_database_files(self) -> None:
        """Reject symlink aliases and keep SQLite state owner-only at rest."""
        if str(self.db_path) == ":memory:":
            return
        if self.db_path.parent.name == ".penny":
            self.db_path.parent.chmod(0o700)
        for candidate in (
            self.db_path,
            Path(f"{self.db_path}-wal"),
            Path(f"{self.db_path}-shm"),
        ):
            if candidate.is_symlink():
                raise PermissionError(
                    f"orchestration database path cannot be a symlink: {candidate}"
                )
            if candidate.exists():
                candidate.chmod(0o600)

    # -- connection -------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        self._harden_database_files()
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        if str(self.db_path) != ":memory:":
            conn.execute("PRAGMA journal_mode=WAL")
            self._harden_database_files()
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

    def put_artifact(self, envelope: dict) -> None:
        """Insert one immutable artifact; an ID/version collision must be byte-identical."""
        import json

        from .code_artifacts import ArtifactEnvelope, ArtifactValidationError

        validated = ArtifactEnvelope.from_dict(envelope)
        encoded = json.dumps(validated.to_dict(), ensure_ascii=False, sort_keys=True)
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT envelope_json FROM artifacts WHERE artifact_id = ?",
                (validated.artifact_id,),
            ).fetchone()
            if existing is not None:
                if existing["envelope_json"] != encoded:
                    raise ArtifactValidationError(
                        f"artifact id collision for {validated.artifact_id!r}"
                    )
                conn.commit()
                return
            conn.execute(
                """
                INSERT INTO artifacts (
                    artifact_id, run_id, kind, version, schema_version,
                    envelope_json, envelope_digest, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    validated.artifact_id,
                    validated.run_id,
                    validated.kind,
                    validated.version,
                    validated.schema_version,
                    encoded,
                    validated.envelope_digest,
                    validated.created_at,
                ),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def get_artifact(self, artifact_id: str) -> dict | None:
        """Recover one artifact with exactly the content originally registered."""
        import json

        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT envelope_json FROM artifacts WHERE artifact_id = ?", (artifact_id,)
            ).fetchone()
            return json.loads(row["envelope_json"]) if row else None
        finally:
            conn.close()

    def select_artifact(
        self,
        *,
        run_id: str,
        kind: str,
        artifact_id: str,
        version: int,
        expected_artifact_id: str | None,
    ) -> None:
        """CAS-select an exact artifact version, rejecting stale concurrent writers."""
        from .code_artifacts import SelectionConflictError

        now = _now()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            artifact = conn.execute(
                """
                SELECT run_id, kind, version FROM artifacts WHERE artifact_id = ?
                """,
                (artifact_id,),
            ).fetchone()
            if artifact is None:
                raise SelectionConflictError(f"cannot select missing artifact {artifact_id!r}")
            if (
                artifact["run_id"] != run_id
                or artifact["kind"] != kind
                or artifact["version"] != version
            ):
                raise SelectionConflictError("selected artifact run/kind/version mismatch")
            current = conn.execute(
                "SELECT artifact_id FROM artifact_selections WHERE run_id = ? AND kind = ?",
                (run_id, kind),
            ).fetchone()
            current_id = current["artifact_id"] if current else None
            if current_id != expected_artifact_id:
                raise SelectionConflictError(
                    f"stale artifact selection for {kind!r}: expected "
                    f"{expected_artifact_id!r}, found {current_id!r}"
                )
            conn.execute(
                """
                INSERT INTO artifact_selections (run_id, kind, artifact_id, version, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id, kind) DO UPDATE SET
                  artifact_id = excluded.artifact_id,
                  version = excluded.version,
                  updated_at = excluded.updated_at
                """,
                (run_id, kind, artifact_id, version, now),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def list_artifacts(self, run_id: str, kind: str | None = None) -> list[dict]:
        """Recover immutable artifact envelopes in deterministic creation/version order."""
        import json

        sql = "SELECT envelope_json FROM artifacts WHERE run_id = ?"
        params: list[object] = [run_id]
        if kind is not None:
            sql += " AND kind = ?"
            params.append(kind)
        sql += " ORDER BY created_at, kind, version, artifact_id"
        conn = self._connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            return [json.loads(row["envelope_json"]) for row in rows]
        finally:
            conn.close()

    def get_selected_artifact(self, run_id: str, kind: str) -> dict | None:
        conn = self._connect()
        try:
            row = conn.execute(
                """
                SELECT s.artifact_id, s.kind, s.version, a.envelope_digest
                FROM artifact_selections AS s
                JOIN artifacts AS a ON a.artifact_id = s.artifact_id
                WHERE s.run_id = ? AND s.kind = ?
                """,
                (run_id, kind),
            ).fetchone()
            if row is None:
                return None
            return {
                "artifact_id": row["artifact_id"],
                "kind": row["kind"],
                "version": row["version"],
                "digest": row["envelope_digest"],
            }
        finally:
            conn.close()

    def list_selected_artifacts(self, run_id: str) -> dict[str, dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                """
                SELECT s.artifact_id, s.kind, s.version, a.envelope_digest
                FROM artifact_selections AS s
                JOIN artifacts AS a ON a.artifact_id = s.artifact_id
                WHERE s.run_id = ? ORDER BY s.kind
                """,
                (run_id,),
            ).fetchall()
            return {
                row["kind"]: {
                    "artifact_id": row["artifact_id"],
                    "kind": row["kind"],
                    "version": row["version"],
                    "digest": row["envelope_digest"],
                }
                for row in rows
            }
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

    def list_pending(
        self, session_id: str | None = None, include_errored: bool = False
    ) -> list[CheckpointRecord]:
        """Return resumable runs (status running/awaiting_user), for the
        auto-recovery scan. Optionally scoped to one session.

        ``include_errored`` (F2): when True, ``error`` runs are ALSO returned so
        an EXPLICIT retry path can re-drive the phase they failed on. Default
        False keeps the automatic recovery scan unchanged (errored runs are not
        auto-retried).
        """
        statuses: tuple[str, ...] = (
            PENDING_STATUSES + (STATUS_ERROR,) if include_errored else PENDING_STATUSES
        )
        placeholders = ",".join("?" for _ in statuses)
        params: list[str] = list(statuses)
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
