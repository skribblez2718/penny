"""Penny Observability Backend — FastAPI + SQLite ingestion and querying server."""

# ---------------------------------------------------------------------------
# FTS5 guarantee (must run before aiosqlite/sqlite3 is imported anywhere).
#
# The schema uses an FTS5 virtual table (``entries_search``). Some CPython
# builds ship SQLite compiled WITHOUT the FTS5 module — notably the
# uv-managed ``cpython-*-gnu`` standalone build used by Penny's local .venv —
# which makes the server and its tests fail on ``connect()`` when NOT run under
# Docker. When the stdlib build lacks FTS5, transparently swap in ``pysqlite3``
# (a statically-linked modern SQLite that includes FTS5) using the same
# mechanism chromadb uses. This is a no-op when the stdlib already has FTS5 or
# when pysqlite3 is unavailable.
# ---------------------------------------------------------------------------
def _ensure_fts5_sqlite() -> None:
    import sqlite3

    try:
        _conn = sqlite3.connect(":memory:")
        try:
            _conn.execute("CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)")
            return  # stdlib SQLite already supports FTS5 — nothing to do
        finally:
            _conn.close()
    except sqlite3.OperationalError:
        pass  # stdlib lacks FTS5 — try to swap in pysqlite3 below

    try:
        import sys

        __import__("pysqlite3")
        sys.modules["sqlite3"] = sys.modules.pop("pysqlite3")
        _dbapi2 = getattr(sys.modules["sqlite3"], "dbapi2", None)
        if _dbapi2 is not None:
            sys.modules["sqlite3.dbapi2"] = _dbapi2
    except ImportError:
        # No pysqlite3 available; leave the stdlib module in place. Schema
        # creation will then fail loudly at connect() if FTS5 is truly needed,
        # which is the correct behaviour (better than silent corruption).
        pass


_ensure_fts5_sqlite()

__version__ = "0.1.0"
