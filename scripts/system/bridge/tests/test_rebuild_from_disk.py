"""Regression tests for operation handling in the offline palace rebuilder."""

import sqlite3
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rebuild_from_disk import read_pending  # noqa: E402


def _queue(tmp_path, rows):
    palace = tmp_path / "palace"
    palace.mkdir()
    conn = sqlite3.connect(palace / "chroma.sqlite3")
    conn.execute(
        "CREATE TABLE embeddings_queue ("
        "seq_id INTEGER PRIMARY KEY, operation INTEGER, id TEXT, vector BLOB)"
    )
    conn.executemany("INSERT INTO embeddings_queue VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    conn.close()
    return palace


def _vec(*values):
    return struct.pack("<" + "f" * len(values), *values)


def test_chromadb_operation_codes_are_not_confused(tmp_path):
    """0 ADD, 1 UPDATE, 2 UPSERT, 3 DELETE — especially 1 is NOT delete."""
    palace = _queue(
        tmp_path,
        [
            (1, 0, "added", _vec(1.0, 2.0)),
            (2, 1, "metadata-only-update", None),
            (3, 1, "vector-update", _vec(3.0, 4.0)),
            (4, 2, "upserted", _vec(5.0, 6.0)),
            (5, 3, "deleted", None),
        ],
    )
    vectors, deleted = read_pending(palace)

    assert set(vectors) == {"added", "vector-update", "upserted"}
    assert vectors["vector-update"] == [3.0, 4.0]
    assert deleted == {"deleted"}
    assert "metadata-only-update" not in deleted


def test_later_operation_wins_for_same_id(tmp_path):
    palace = _queue(
        tmp_path,
        [
            (1, 0, "x", _vec(1.0)),
            (2, 3, "x", None),
            (3, 2, "x", _vec(2.0)),
            (4, 1, "x", None),  # metadata-only update preserves vector
        ],
    )
    vectors, deleted = read_pending(palace)

    assert vectors == {"x": [2.0]}
    assert deleted == set()
