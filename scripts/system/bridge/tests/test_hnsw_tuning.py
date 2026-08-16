"""Regression guard: bounded-WAL settings must be applied at EVERY creation site.

History this protects against
-----------------------------
The palace segfaulted (SIGSEGV, native ChromaDB core) roughly every 1-2 weeks
for months. The accepted explanation was "the index is corrupted, rebuild it",
and `repair_palace.py` did rebuild it — using ChromaDB's stock defaults. Stock
default `sync_threshold` is 1000; the bridge runs as a fresh process per call and
lets metadata-only recall UPDATEs and ADDs accumulate while HNSW persistence
lags, so every call replays a large backlog. Historical byte-identical corpora
with zero pending DELETEs prove that sufficiently large UPDATE+ADD replay can
trip an upstream NULL-deref and wedge the palace. The "fix" was re-arming the
cause on its way out.

So: a rebuild that silently drops HNSW_TUNING is not a cosmetic regression, it
is the bug. These tests fail loudly if that ever happens again.

ChromaDB honors these settings ONLY at collection creation — `collection.modify()`
is accepted, is persisted to `collection_metadata`, and is then ignored by the
Rust core. That is why they must be passed to `get_or_create_collection`.
"""

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

chromadb = pytest.importorskip("chromadb")

from memory_bridge import HNSW_TUNING  # noqa: E402
import repair_palace  # noqa: E402


def _stored_tuning(palace: Path) -> dict:
    """Read back the HNSW settings ChromaDB actually persisted."""
    conn = sqlite3.connect(f"file:{palace / 'chroma.sqlite3'}?mode=ro", uri=True)
    try:
        return {
            key: val
            for key, val in conn.execute(
                "SELECT key, int_value FROM collection_metadata WHERE key LIKE 'hnsw:%'"
            )
        }
    finally:
        conn.close()


def test_tuning_bounds_the_wal_well_below_the_measured_crash_range():
    """Measured on the live palace: 142 records clean, 162 crashed 4/4."""
    assert HNSW_TUNING["hnsw:sync_threshold"] <= 100
    assert HNSW_TUNING["hnsw:batch_size"] <= HNSW_TUNING["hnsw:sync_threshold"]


def test_repair_rebuild_persists_the_tuning(tmp_path):
    """A rebuilt palace must come back bounded, not stock-default."""
    dest = tmp_path / "rebuilt"
    ids = [f"drawer_{i}" for i in range(20)]
    docs = [f"content {i}" for i in range(20)]
    metas = [{"wing": "penny", "room": "test"} for _ in ids]

    repair_palace._build(dest, "mempalace_drawers", ids, docs, metas)

    stored = _stored_tuning(dest)
    for key, expected in HNSW_TUNING.items():
        assert stored.get(key) == expected, f"rebuild dropped {key}: got {stored.get(key)}"


def test_verify_tuning_accepts_a_correctly_tuned_rebuild(tmp_path):
    dest = tmp_path / "tuned"
    repair_palace._build(dest, "mempalace_drawers", ["a"], ["doc"], [{"wing": "w"}])
    assert repair_palace._verify_tuning(dest, HNSW_TUNING) == dict(HNSW_TUNING)


def test_verify_tuning_rejects_a_palace_that_lost_the_settings(tmp_path):
    """The guard that stops a rebuild from shipping an unbounded-WAL palace.

    Without this the rebuild silently re-arms the original fault — which is
    precisely what kept the crash recurring for months.
    """
    dest = tmp_path / "tuned"
    repair_palace._build(dest, "mempalace_drawers", ["a"], ["doc"], [{"wing": "w"}])
    with pytest.raises(RuntimeError, match="did not persist HNSW tuning"):
        repair_palace._verify_tuning(dest, {"hnsw:sync_threshold": 999999})


def test_chromadb_rejects_malformed_tuning_outright(tmp_path, monkeypatch):
    """Belt and braces: a non-integer threshold fails at creation, not silently."""
    monkeypatch.setattr(repair_palace, "_hnsw_tuning", lambda: {"hnsw:sync_threshold": "64"})
    with pytest.raises(Exception, match="hnsw parameters"):
        repair_palace._build(tmp_path / "bad", "mempalace_drawers", ["a"], ["doc"], [{"wing": "w"}])


def test_bridge_creates_collections_with_tuning(tmp_path, monkeypatch):
    """The bridge's own create path must be tuned too — a palace created by a
    plain `add_drawer` on a fresh machine must not be born defective."""
    import memory_bridge

    class _Cfg:  # MempalaceConfig.palace_path is a read-only property
        palace_path = str(tmp_path)

    monkeypatch.setattr(memory_bridge, "_config", _Cfg())
    col = memory_bridge._get_collection(create=True)
    assert col is not None, "bridge failed to create the collection"
    col.add(ids=["seed"], documents=["seed doc"])

    stored = _stored_tuning(tmp_path)
    for key, expected in HNSW_TUNING.items():
        assert stored.get(key) == expected, f"bridge created collection without {key}"
