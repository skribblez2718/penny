#!/usr/bin/env python3
"""Rebuild a receipt-gated copied/offline palace without opening the damaged index.

When to reach for this
----------------------
`repair_palace.py` and `rebuild_collection_index.py` both drive the repair
THROUGH ChromaDB — they open a client and call `col.count()` before doing
anything. That works for a palace that merely returns errors. It cannot work
for a palace whose vector segment is TORN, because the count itself segfaults
the process: there is no Python-level exception to catch, the interpreter dies.
That is the state the store reached on 2026-08-11.

This tool never opens the damaged store. It reads the pieces directly:

  * documents + metadata  <- chroma.sqlite3 (`embedding_metadata`), always intact,
                             because SQLite serializes its own writers
  * exact vectors         <- the hnswlib segment files, parsed by hand, skipping
                             tombstoned nodes
  * pending vectors       <- `embeddings_queue`, for rows written but not yet
                             compacted into the vector segment

and writes a brand-new palace from them. Because the original float32 vectors
are recovered byte-for-byte, nothing is re-embedded: the rebuild is exact and
takes seconds rather than an embedding pass, and semantic recall is unchanged.

The new collection is created WITH the bridge's HNSW_TUNING, since ChromaDB
honors those settings only at creation time (see test_hnsw_tuning.py).

Safety
------
Dry-run by default; ``--apply`` writes a new directory and swaps it only inside
the copied target, moving the input copy aside rather than deleting it.
Verification runs before that swap in a subprocess.

Usage:
    python -m scripts.system.bridge.rebuild_from_disk \\
      --offline-target /absolute/copied-palace \\
      --receipt /absolute/offline-receipt.json [--apply]
"""

from __future__ import annotations

import argparse
import pickle
import shutil
import sqlite3
import struct
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Sequence

from scripts.system.bridge.fts5_integrity import probe_authorized_database
from scripts.system.memory.hnsw import HNSW_TUNING
from scripts.system.memory.offline_access import authorize_offline_target

COLLECTION = "mempalace_drawers"
BATCH = 500

_VERIFY = textwrap.dedent("""
    import sys, chromadb, numpy as np
    palace, collection, expected = sys.argv[1], sys.argv[2], int(sys.argv[3])
    col = chromadb.PersistentClient(path=palace).get_collection(collection)
    assert col.count() == expected, f"count {col.count()} != expected {expected}"
    page = col.get(limit=25, include=["embeddings"])
    hits = 0
    for i, e in zip(page["ids"], np.array(page["embeddings"])):
        if col.query(query_embeddings=[e.tolist()], n_results=1)["ids"][0][0] == i:
            hits += 1
    assert hits == len(page["ids"]), f"self-recall {hits}/{len(page['ids'])}"
    # The filtered query whose candidate set is largest — the shape that first
    # exposed stale-id corruption historically.
    col.query(query_texts=["probe"], n_results=3, where={"wing": "penny"})
    print(f"VERIFIED count={col.count()} self_recall={hits}/{len(page['ids'])}")
    """)


def _typed(row: sqlite3.Row) -> object:
    """Pick whichever typed column of an embedding_metadata row is populated."""
    for key in ("string_value", "int_value", "float_value", "bool_value"):
        val = row[key]
        if val is not None:
            return bool(val) if key == "bool_value" else val
    return None


def read_sqlite(palace: Path) -> tuple[dict, dict]:
    """Return ({id: document}, {id: metadata}) straight from the metadata segment."""
    conn = sqlite3.connect(f"file:{palace / 'chroma.sqlite3'}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        seg = conn.execute(
            "SELECT s.id FROM segments s JOIN collections c ON c.id = s.collection "
            "WHERE c.name = ? AND s.scope = 'METADATA'",
            (COLLECTION,),
        ).fetchone()[0]
        rowid_to_id = {
            r["id"]: r["embedding_id"]
            for r in conn.execute(
                "SELECT id, embedding_id FROM embeddings WHERE segment_id = ?", (seg,)
            )
        }
        docs: dict = {}
        metas: dict = {}
        for r in conn.execute("SELECT * FROM embedding_metadata"):
            eid = rowid_to_id.get(r["id"])
            if eid is None:
                continue
            if r["key"] == "chroma:document":
                docs[eid] = r["string_value"]
            else:
                metas.setdefault(eid, {})[r["key"]] = _typed(r)
        return docs, metas
    finally:
        conn.close()


def read_pending(palace: Path) -> tuple[dict, set]:
    """Return ({id: vector}, {deleted ids}) from the uncompacted write-ahead log.

    ChromaDB's persisted operation codes are load-bearing:
        0 ADD, 1 UPDATE, 2 UPSERT, 3 DELETE
    Metadata-only UPDATE rows have no vector and must be ignored here — their
    latest metadata is already represented in SQLite's metadata segment. An
    earlier version mistook operation 1 for DELETE and dropped live drawers.
    """
    conn = sqlite3.connect(f"file:{palace / 'chroma.sqlite3'}?mode=ro", uri=True)
    try:
        import numpy as np

        adds: dict = {}
        deletes: set = set()
        for op, eid, vec in conn.execute(
            "SELECT operation, id, vector FROM embeddings_queue ORDER BY seq_id"
        ):
            if op in (0, 2) and vec is not None:  # ADD / UPSERT
                adds[eid] = np.frombuffer(vec, dtype="<f4").tolist()
                deletes.discard(eid)
            elif op == 1 and vec is not None:  # UPDATE with a replacement vector
                adds[eid] = np.frombuffer(vec, dtype="<f4").tolist()
            elif op == 3:  # DELETE
                deletes.add(eid)
                adds.pop(eid, None)
        return adds, deletes
    finally:
        conn.close()


def read_index_vectors(palace: Path) -> dict:
    """Recover {id: vector} from the hnswlib segment files, skipping tombstones.

    The segment is parsed directly rather than through ChromaDB precisely
    because ChromaDB cannot open it in this state.
    """
    import numpy as np

    seg_dirs = [p for p in palace.iterdir() if p.is_dir() and (p / "header.bin").exists()]
    if not seg_dirs:
        return {}
    d = max(seg_dirs, key=lambda p: (p / "data_level0.bin").stat().st_size)

    header = (d / "header.bin").read_bytes()
    # 4-byte prefix, then size_t: offsetLevel0, max_elements, cur_element_count,
    # size_data_per_element, label_offset, offsetData.
    _, _, cur, size_per_elem, label_off, off_data = struct.unpack_from("<QQQQQQ", header, 4)

    raw = np.fromfile(d / "data_level0.bin", dtype=np.uint8)
    usable = min(cur, raw.size // size_per_elem)  # tolerate a truncated tail
    m = raw[: usable * size_per_elem].reshape(usable, size_per_elem)

    # Level-0 link word carries hnswlib's delete mark in bit 16.
    deleted = (m[:, 0:4].copy().view(np.uint32).ravel() & 0x10000) != 0
    labels = m[:, label_off : label_off + 8].copy().view(np.uint64).ravel()
    dim = (label_off - off_data) // 4
    vectors = m[:, off_data : off_data + dim * 4].copy().view(np.float32).reshape(usable, dim)

    label_to_id = pickle.load(open(d / "index_metadata.pickle", "rb"))["label_to_id"]

    out: dict = {}
    for i in range(usable):
        if deleted[i]:
            continue
        eid = label_to_id.get(int(labels[i]))
        if eid is None:
            continue
        v = vectors[i]
        if not np.isfinite(v).all():
            continue  # never carry a poisoned vector into the new index
        out[eid] = v.tolist()
    return out


def build(dest: Path, records: list) -> None:
    """Write a fresh palace containing exactly ``records``."""
    import chromadb

    client = chromadb.PersistentClient(path=str(dest))
    col = client.create_collection(COLLECTION, metadata=dict(HNSW_TUNING))
    for i in range(0, len(records), BATCH):
        chunk = records[i : i + BATCH]
        col.add(
            ids=[r["id"] for r in chunk],
            embeddings=[r["embedding"] for r in chunk],
            documents=[r["document"] for r in chunk],
            metadatas=[r["metadata"] for r in chunk],
        )


def verify(palace: Path, expected: int) -> tuple[bool, str]:
    """Check the rebuilt palace in a child process (a bad one would segfault us)."""
    script = palace.parent / ".verify_rebuild.py"
    script.write_text(_VERIFY)
    try:
        out = subprocess.run(
            [sys.executable, str(script), str(palace), COLLECTION, str(expected)],
            capture_output=True,
            timeout=900,
        )
    except subprocess.TimeoutExpired:
        return False, "verification timed out"
    finally:
        script.unlink(missing_ok=True)
    detail = (out.stdout + out.stderr).decode().strip().splitlines()
    tail = detail[-1] if detail else ""
    if out.returncode != 0:
        return False, f"rc={out.returncode} {tail}"
    return True, tail


@dataclass(frozen=True)
class RecoveryInput:
    """Source records and content-free counts prepared for an offline rebuild."""

    records: list[dict]
    missing: list[str]
    document_count: int
    index_vector_count: int
    pending_vector_count: int
    pending_delete_count: int


def _collect_recovery_input(palace: Path) -> RecoveryInput:
    docs, metas = read_sqlite(palace)
    idx_vecs = read_index_vectors(palace)
    pending_vecs, pending_deletes = read_pending(palace)
    vectors = {**idx_vecs, **pending_vecs}  # WAL wins: it is the newer write
    ids = [item_id for item_id in docs if item_id not in pending_deletes]

    records: list[dict] = []
    missing: list[str] = []
    for item_id in ids:
        vector = vectors.get(item_id)
        if vector is None:
            missing.append(item_id)
            continue
        records.append(
            {
                "id": item_id,
                "document": docs[item_id],
                "metadata": metas.get(item_id) or {},
                "embedding": vector,
            }
        )
    return RecoveryInput(
        records=records,
        missing=missing,
        document_count=len(docs),
        index_vector_count=len(idx_vecs),
        pending_vector_count=len(pending_vecs),
        pending_delete_count=len(pending_deletes),
    )


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--offline-target", required=True, type=Path)
    ap.add_argument("--receipt", required=True, type=Path)
    ap.add_argument("--apply", action="store_true", help="execute inside the copy")
    args = ap.parse_args(argv)

    authorization = authorize_offline_target(args.offline_target, args.receipt)
    palace = authorization.target
    integrity = probe_authorized_database(authorization)
    if not integrity.repair_safe:
        print(
            "ABORT: temporary-copy integrity probe found unclassified SQLite corruption; "
            "refusing to rebuild from potentially damaged source rows."
        )
        return 1
    if integrity.corrupt_fts5_tables:
        print(
            "classified FTS5 index corruption detected on the temporary probe copy; "
            "disk rebuild may proceed"
        )
    recovery = _collect_recovery_input(palace)
    records = recovery.records
    missing = recovery.missing

    print(f"palace          : {palace}")
    print(f"documents       : {recovery.document_count}")
    print(f"vectors (index) : {recovery.index_vector_count}")
    print(f"vectors (WAL)   : {recovery.pending_vector_count}")
    print(f"pending deletes : {recovery.pending_delete_count}")
    print(f"recoverable     : {len(records)}")
    print(f"UNRECOVERABLE   : {len(missing)}{' -> ' + str(missing[:5]) if missing else ''}")

    if missing:
        print(
            "\nABORT: some drawers have a document but no recoverable vector. "
            "Re-embedding is required for those; refusing to silently drop them."
        )
        return 1
    if not args.apply:
        print("\nDRY RUN — re-run with --apply to rebuild and swap inside this copy.")
        return 0

    staged = palace.parent / f"{palace.name}.rebuilt"
    if staged.exists():
        shutil.rmtree(staged)
    print(f"\nbuilding {staged} ...")
    build(staged, records)

    ok, detail = verify(staged, len(records))
    print(f"verify: {detail}")
    if not ok:
        print(f"ABORT: rebuilt palace failed verification — original untouched, staged at {staged}")
        return 1

    parked = palace.parent / f"{palace.name}.wedged-{datetime.now():%Y%m%d-%H%M%S}"
    # Carry forward anything that is not ChromaDB's own state (cold archives etc).
    for extra in palace.iterdir():
        if extra.name != "chroma.sqlite3" and not (extra / "header.bin").exists():
            if extra.name != ".palace.lock":
                shutil.copytree(extra, staged / extra.name, dirs_exist_ok=True)
    palace.rename(parked)
    staged.rename(palace)
    print(f"OK: palace rebuilt ({len(records)} drawers). Previous store parked at {parked}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
