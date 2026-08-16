"""Hermetic tests for receipt-gated, read-only palace diagnostics."""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import palace_doctor  # noqa: E402


def _receipt(tmp_path: Path, palace: Path) -> Path:
    receipt = tmp_path / f"{palace.name}-receipt.json"
    receipt.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "receipt_type": "memory-offline-access",
                "target_kind": "copied-offline",
                "target_path": str(palace),
                "source_id": "synthetic-doctor-test",
                "authority_timestamp": "2026-08-15T12:00:00Z",
                "approved_by": "pytest",
                "checks": {
                    "drain_complete": True,
                    "hub_stopped": True,
                    "peer_processes_stopped": True,
                    "target_is_copy": True,
                },
            }
        ),
        encoding="utf-8",
    )
    receipt.chmod(0o600)
    return receipt


def _make_palace(
    tmp_path: Path,
    *,
    backlog: int = 0,
    tuned: bool = True,
    drawers: int = 10,
    vec_seq: int = 100,
    meta_seq: int = 100,
) -> Path:
    palace = tmp_path / "copied-palace"
    palace.mkdir()
    db = palace / "chroma.sqlite3"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE embeddings (id INTEGER PRIMARY KEY, embedding_id TEXT, seq_id INTEGER);
        CREATE TABLE embeddings_queue (seq_id INTEGER PRIMARY KEY, operation INTEGER, id TEXT);
        CREATE TABLE max_seq_id (segment_id TEXT, seq_id INTEGER);
        CREATE TABLE segments (id TEXT, scope TEXT);
        CREATE TABLE collection_metadata (key TEXT, str_value TEXT, int_value INTEGER);
        """)
    conn.executemany(
        "INSERT INTO embeddings (embedding_id, seq_id) VALUES (?, ?)",
        [(f"drawer_{i}", i) for i in range(drawers)],
    )
    conn.executemany(
        "INSERT INTO embeddings_queue (seq_id, operation, id) VALUES (?, ?, ?)",
        [(1000 + i, 1, f"drawer_{i}") for i in range(backlog)],
    )
    conn.executemany(
        "INSERT INTO segments (id, scope) VALUES (?, ?)",
        [("vec-seg", "VECTOR"), ("meta-seg", "METADATA")],
    )
    conn.executemany(
        "INSERT INTO max_seq_id (segment_id, seq_id) VALUES (?, ?)",
        [("vec-seg", vec_seq), ("meta-seg", meta_seq)],
    )
    if tuned:
        conn.executemany(
            "INSERT INTO collection_metadata (key, str_value, int_value) VALUES (?, ?, ?)",
            [("hnsw:sync_threshold", None, 64), ("hnsw:batch_size", None, 32)],
        )
    conn.commit()
    conn.close()
    return palace


def _diagnose(tmp_path: Path, palace: Path) -> dict:
    return palace_doctor.diagnose(palace, _receipt(tmp_path, palace))


def test_healthy_palace_is_ok(tmp_path: Path) -> None:
    result = _diagnose(tmp_path, _make_palace(tmp_path, backlog=5, tuned=True))
    assert result["ok"] is True
    assert "healthy" in result["verdict"].lower()
    assert result["stats"]["sync_threshold"] == 64


def test_untuned_collection_is_flagged_as_recurrence_risk(tmp_path: Path) -> None:
    result = _diagnose(tmp_path, _make_palace(tmp_path, backlog=5, tuned=False))
    assert result["ok"] is False
    assert "unbounded" in result["verdict"].lower()
    assert "repair_palace.py" in result["action"]
    assert any("sync_threshold" in detail for detail in result["detail"])


def test_backlog_in_measured_crash_range_is_critical(tmp_path: Path) -> None:
    palace = _make_palace(tmp_path, backlog=palace_doctor.WAL_CRITICAL + 10, tuned=True)
    result = _diagnose(tmp_path, palace)
    assert result["ok"] is False
    assert "crash range" in result["verdict"]


def test_elevated_backlog_warns_without_failing(tmp_path: Path) -> None:
    palace = _make_palace(tmp_path, backlog=palace_doctor.WAL_WARN + 1, tuned=True)
    result = _diagnose(tmp_path, palace)
    assert result["ok"] is True
    assert "elevated" in result["verdict"]
    assert result["action"]


def test_warn_threshold_sits_below_measured_crash_floor() -> None:
    assert palace_doctor.WAL_WARN < palace_doctor.WAL_CRITICAL <= 162


def test_reports_operation_codes_correctly(tmp_path: Path) -> None:
    palace = _make_palace(tmp_path, backlog=4, tuned=True)
    conn = sqlite3.connect(palace / "chroma.sqlite3")
    conn.executemany(
        "INSERT INTO embeddings_queue (seq_id, operation, id) VALUES (?, ?, ?)",
        [(2000, 0, "add"), (2001, 2, "upsert"), (2002, 3, "delete")],
    )
    conn.commit()
    conn.close()

    stats = _diagnose(tmp_path, palace)["stats"]
    assert stats["wal_adds"] == 1
    assert stats["wal_updates"] == 4
    assert stats["wal_upserts"] == 1
    assert stats["wal_deletes"] == 1


def test_reports_segment_drift(tmp_path: Path) -> None:
    palace = _make_palace(tmp_path, backlog=20, tuned=True, vec_seq=900, meta_seq=1000)
    result = _diagnose(tmp_path, palace)
    assert result["stats"]["segment_drift"] == 100
    assert any("behind metadata" in detail for detail in result["detail"])


def test_missing_database_is_reported_not_crashed(tmp_path: Path) -> None:
    palace = tmp_path / "empty-copy"
    palace.mkdir()
    result = _diagnose(tmp_path, palace)
    assert result["ok"] is False
    assert "No chroma.sqlite3" in result["verdict"]


def test_doctor_reports_classified_fts5_corruption_from_temp_probe(tmp_path: Path) -> None:
    palace = _make_palace(tmp_path, backlog=5, tuned=True)
    with sqlite3.connect(palace / "chroma.sqlite3") as connection:
        connection.execute("CREATE VIRTUAL TABLE search_index USING fts5(value)")
        connection.executemany(
            "INSERT INTO search_index(value) VALUES (?)",
            [(f"alpha beta row{index}",) for index in range(200)],
        )
        connection.commit()
        connection.execute(
            "UPDATE search_index_data SET block = zeroblob(length(block)) "
            "WHERE id = (SELECT max(id) FROM search_index_data)"
        )
        connection.commit()

    result = _diagnose(tmp_path, palace)

    assert result["ok"] is False
    assert "Classified FTS5" in result["verdict"]
    assert result["stats"]["sqlite_integrity"]["repair_safe"] is True
    assert result["stats"]["sqlite_integrity"]["findings"] == [
        {
            "code": "fts5-index-corrupt",
            "classification": "fts5-index-corruption",
            "table": "search_index",
            "sqlite_error_name": "SQLITE_CORRUPT_VTAB",
        }
    ]
    assert "--fts5-only" in result["action"]


def test_doctor_never_opens_the_copy_read_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    palace = _make_palace(tmp_path, backlog=5, tuned=True)
    receipt = _receipt(tmp_path, palace)
    opened: list[tuple] = []
    real_connect = sqlite3.connect

    def spy(*args, **kwargs):
        opened.append((args, kwargs))
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", spy)
    palace_doctor.diagnose(palace, receipt)

    assert opened
    source = str(palace / "chroma.sqlite3")
    source_opens = [(args, kwargs) for args, kwargs in opened if args and source in str(args[0])]
    assert source_opens
    for args, kwargs in source_opens:
        assert kwargs.get("uri") is True
        assert "mode=ro" in str(args[0])


def test_main_reports_gate_failure_without_touching_a_default(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert palace_doctor.main(["--offline-target", "relative", "--receipt", "relative"]) == 1
    assert "palace_doctor failed" in capsys.readouterr().out
