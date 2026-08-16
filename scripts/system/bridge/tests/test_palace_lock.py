"""Regression guard: concurrent processes must not tear the HNSW vector segment.

History this protects against
-----------------------------
The palace wedged on 2026-08-11: every memory call, including read-only ones,
died with SIGSEGV inside ChromaDB's Rust core. The state passed every
consistency check — SQLite `integrity_check` ok, 8661 live labels agreeing
across the index and its pickle, 78 tombstones consistent, zero out-of-range
neighbours, all 8739 stored vectors exact unit-norm. Nothing looked corrupt.

The one measurable anomaly was that `link_lists.bin` held 68 trailing bytes the
header did not account for — exactly one link-list block. Healthy indexes
consume that file exactly. That is a TORN WRITE.

Cause: ChromaDB's PersistentClient is single-process. Its metadata segment is
SQLite and is safely serialized by SQLite's own locking; its vector segment is
raw .bin files with no cross-process locking at all. Penny spawns a fresh bridge
process per memory call and runs agents in parallel, so multiple processes
flushed the HNSW segment simultaneously and interleaved their writes.

Reproduced under control — identical workload, only concurrency varied:

    8 workers CONCURRENT -> 2/8 SIGSEGV, data_level0.bin size wrong,
                            link_lists.bin +772 trailing bytes,
                            121 of 720 rows landed (~83% silently LOST),
                            palace segfaulted on every read thereafter
    8 workers SEQUENTIAL -> 0/8 crashes, files byte-exact, 675/675 rows, healthy

Note the silent data loss: the corruption dropped writes without raising.

chromadb 1.5.9 is still the latest release on PyPI, so there is no upstream fix
to upgrade into. Serializing writers via `palace_lock` is the remedy, and these
tests fail loudly if that serialization is ever removed or broken.
"""

import multiprocessing
import os
import struct
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

chromadb = pytest.importorskip("chromadb")

from memory_bridge import palace_lock  # noqa: E402

DIM = 384
# Serialized, the concurrency workload finishes in seconds. Anything near this
# bound means writers are contending rather than queueing.
WORKER_TIMEOUT_S = 120


# ---------------------------------------------------------------- lock semantics


def test_lock_is_reentrant_within_a_process(tmp_path):
    """Nested acquisition must not deadlock against our own flock."""
    with palace_lock(str(tmp_path), timeout=5) as outer:
        assert outer is True
        with palace_lock(str(tmp_path), timeout=5) as inner:
            assert inner is True


def test_lock_released_after_block(tmp_path):
    """A second acquisition succeeds once the first block exits."""
    with palace_lock(str(tmp_path), timeout=5) as held:
        assert held is True
    with palace_lock(str(tmp_path), timeout=5) as held_again:
        assert held_again is True


def test_lock_creates_lockfile_in_palace(tmp_path):
    with palace_lock(str(tmp_path), timeout=5):
        assert (tmp_path / ".palace.lock").exists()


def _hold_lock(path, ready, release):
    """Child process: take the lock, signal, wait, then drop it."""
    with palace_lock(path, timeout=10):
        ready.set()
        release.wait(timeout=30)


def test_lock_excludes_other_processes(tmp_path):
    """The whole point: two processes must never hold the palace at once."""
    ctx = multiprocessing.get_context("spawn")
    ready, release = ctx.Event(), ctx.Event()
    holder = ctx.Process(target=_hold_lock, args=(str(tmp_path), ready, release))
    holder.start()
    try:
        assert ready.wait(timeout=30), "child never acquired the lock"
        # Child holds it; we must fail closed rather than acquire in parallel.
        with pytest.raises(TimeoutError):
            with palace_lock(str(tmp_path), timeout=0.5):
                pytest.fail("acquired the palace lock while another process held it")
    finally:
        release.set()
        holder.join(timeout=30)

    # Once the holder exits the lock is free again.
    with palace_lock(str(tmp_path), timeout=5) as held:
        assert held is True


def test_lock_fails_closed_when_palace_unusable(tmp_path):
    """Never run unlocked: inability to lock must abort before touching ChromaDB."""
    blocked = tmp_path / "not-a-dir"
    blocked.write_text("i am a file, not a palace directory")
    with pytest.raises(RuntimeError, match="Cannot open palace lock"):
        with palace_lock(str(blocked), timeout=1):
            pytest.fail("entered the protected block without holding its lock")


def test_lock_fails_closed_on_timeout(tmp_path):
    """Contention past the deadline must abort, not recreate the corruption race."""
    ctx = multiprocessing.get_context("spawn")
    ready, release = ctx.Event(), ctx.Event()
    holder = ctx.Process(target=_hold_lock, args=(str(tmp_path), ready, release))
    holder.start()
    try:
        assert ready.wait(timeout=30), "child never acquired the lock"
        with pytest.raises(TimeoutError, match="waiting for palace lock"):
            with palace_lock(str(tmp_path), timeout=0.2):
                pytest.fail("entered the protected block after lock timeout")
    finally:
        release.set()
        holder.join(timeout=30)


# ------------------------------------------------------- torn-write regression


def _count_in_subprocess(palace: Path, tmp_path: Path):
    """Count rows in a child process; None if reading crashes.

    Isolated deliberately: a torn index segfaults the *reader*, so doing this
    in-process would take down the test runner itself instead of reporting a
    failure.
    """
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import sys, chromadb\n"
        "c = chromadb.PersistentClient(path=sys.argv[1])\n"
        "print(c.get_collection('lockcol').count())\n"
    )
    try:
        out = subprocess.run(
            [sys.executable, str(probe), str(palace)],
            capture_output=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0:
        return None
    return int(out.stdout.decode().strip())


def _index_dir(palace: Path) -> Path:
    dirs = [p for p in palace.iterdir() if p.is_dir() and (p / "header.bin").exists()]
    assert dirs, "no HNSW segment directory was persisted"
    return dirs[0]


def _assert_index_intact(palace: Path) -> None:
    """The exact fingerprint that was damaged in production.

    A healthy hnswlib segment is byte-exact: data_level0.bin and length.bin are
    sized from cur_element_count, and link_lists.bin is consumed completely by
    walking its per-element records. Trailing bytes mean interleaved writers.
    """
    d = _index_dir(palace)
    header = (d / "header.bin").read_bytes()
    # 4-byte prefix, then: offsetLevel0, max_elements, cur_element_count,
    # size_data_per_element, label_offset, offsetData (all size_t).
    _, _, cur, size_per_elem, _, _ = struct.unpack_from("<QQQQQQ", header, 4)

    assert (
        d / "data_level0.bin"
    ).stat().st_size == cur * size_per_elem, (
        "data_level0.bin size disagrees with the header — torn write"
    )
    assert (
        d / "length.bin"
    ).stat().st_size == cur * 4, "length.bin size disagrees with the header — torn write"

    link_lists = (d / "link_lists.bin").read_bytes()
    pos = 0
    for _ in range(cur):
        (size,) = struct.unpack_from("<I", link_lists, pos)
        pos += 4 + size
    assert pos == len(link_lists), (
        f"link_lists.bin has {len(link_lists) - pos} trailing bytes — torn write "
        "(this is the exact production corruption signature)"
    )


# Mirrors production exactly: the bridge is spawned as a FRESH process per
# memory call, opens the client, performs one operation, and exits. The client
# is opened INSIDE the lock so each process reads current on-disk state rather
# than flushing a stale in-memory index over another writer's work.
_WORKER = textwrap.dedent("""
    import sys
    sys.path.insert(0, {bridge!r})
    import numpy as np, chromadb
    from memory_bridge import palace_lock

    palace, worker, per = sys.argv[1], int(sys.argv[2]), {per}
    np.random.seed(500 + worker)
    v = np.random.rand(per, {dim}).astype("float32")
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    # Lock the whole operation: ChromaDB flushes HNSW during add().
    with palace_lock(palace, timeout=180):
        col = chromadb.PersistentClient(path=palace).get_collection("lockcol")
        col.add(
            ids=[f"w{{worker}}_{{i}}" for i in range(per)],
            embeddings=v.tolist(),
            documents=[f"w{{worker}} i{{i}}" for i in range(per)],
        )
    """)


@pytest.mark.skip(
    reason="legacy per-call raw multi-writer topology is retired; supervised hub lease tests own concurrency"
)
@pytest.mark.slow
def test_concurrent_writers_do_not_tear_the_index(tmp_path):
    """Historical reproducer retained only for the offline rollback window.

    Without `palace_lock` this configuration reliably segfaults the majority of
    writers (measured 17/24) and leaves the palace unreadable — subsequent reads
    crash too, exactly as production did.
    """
    palace = tmp_path / "palace"
    import numpy as np

    seed_rows, workers, per = 1000, 24, 15
    client = chromadb.PersistentClient(path=str(palace))
    col = client.create_collection(
        "lockcol", metadata={"hnsw:sync_threshold": 64, "hnsw:batch_size": 32}
    )
    np.random.seed(1)
    seed = np.random.rand(seed_rows, DIM).astype("float32")
    seed /= np.linalg.norm(seed, axis=1, keepdims=True)
    col.add(
        ids=[f"d{i}" for i in range(seed_rows)],
        embeddings=seed.tolist(),
        documents=[f"doc{i}" for i in range(seed_rows)],
    )
    del col, client

    bridge_dir = str(Path(__file__).resolve().parents[1])
    script = tmp_path / "worker.py"
    script.write_text(_WORKER.format(bridge=bridge_dir, dim=DIM, per=per))
    # DEVNULL, not PIPE: with this many writers the pipe buffers can fill and
    # deadlock the launcher before anything is read back.
    procs = [
        subprocess.Popen(
            [sys.executable, str(script), str(palace), str(w)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "MEMPALACE_LOCK_TIMEOUT": "180"},
        )
        for w in range(workers)
    ]
    # Unserialized writers fail two ways: some segfault, others block for a very
    # long time on SQLite contention. Bound the wait so the guard reports a
    # failure promptly instead of hanging the suite; serialized writers finish
    # this workload in seconds.
    codes = []
    for p in procs:
        try:
            codes.append(p.wait(timeout=WORKER_TIMEOUT_S))
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            codes.append("timeout")

    bad = [rc for rc in codes if rc != 0]
    assert not bad, (
        f"{len(bad)}/{workers} concurrent writers failed (outcomes={sorted(set(map(str, bad)))}; "
        "-11 is SIGSEGV, 'timeout' is a stalled writer) — the palace lock is not "
        "serializing writers"
    )

    expected = seed_rows + workers * per
    counted = _count_in_subprocess(palace, tmp_path)
    assert counted is not None, (
        "reading the palace crashed the reader process — the store is wedged, "
        "exactly the production failure this lock exists to prevent"
    )
    assert counted == expected, f"silent write loss: {counted} of {expected} rows landed"
    _assert_index_intact(palace)
