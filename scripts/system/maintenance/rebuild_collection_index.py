#!/usr/bin/env python3
"""Rebuild the palace collection's vector index from its own stored data.

Why this exists: bulk delete/re-add churn (e.g. the 2026-07 wing migration)
can leave ChromaDB's HNSW segment holding ids the metadata segment no longer
knows, after which *filtered* semantic queries whose candidate set touches a
stale id fail with:

    Error executing plan: Internal error: Error finding id

(observed on `where={"wing": "penny"}` — the store's largest filter — while
metadata-only reads and narrower filters still worked). The fix is to rebuild
the collection from its own ids/documents/metadatas/EMBEDDINGS — no
re-embedding, so it takes seconds, and ids are preserved so knowledge-graph
references and golden-recall cases stay valid.

Procedure (safe: staged through a scratch collection, verified before and
after the swap):
  1. Copy everything into <name>_rebuilt and verify the failing query there.
  2. Drop the original, recreate it, copy back, verify again.
  3. Drop the scratch collection.

Dry-run by default; pass --apply to execute. Take a filesystem backup of the
palace directory first regardless.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts" / "system" / "bridge"))

from memory_bridge import _config, _fix_blob_seq_ids  # noqa: E402

import chromadb  # noqa: E402

COLLECTION = "mempalace_drawers"
SCRATCH = f"{COLLECTION}_rebuilt"
BATCH = 500
# The query shape that exposed the stale-id corruption; used as the health probe.
PROBE_WHERE = {"wing": "penny"}


def _all_ids(src) -> list:
    """Every id, via the metadata segment only (include=[] survives the
    corruption that breaks embedding reads)."""
    ids, offset = [], 0
    while True:
        page = src.get(include=[], limit=BATCH, offset=offset)
        if not page["ids"]:
            return ids
        ids.extend(page["ids"])
        offset += len(page["ids"])


def _try_with_embeddings(src, dst, chunk: list) -> bool:
    try:
        page = src.get(ids=chunk, include=["documents", "metadatas", "embeddings"])
    except Exception:
        return False
    dst.add(
        ids=page["ids"],
        documents=page["documents"],
        metadatas=page["metadatas"],
        embeddings=page["embeddings"],
    )
    return True


def _recover_single(src, dst, row_id: str) -> bool:
    """Re-add one bad row from document + metadata (chroma re-embeds it)."""
    try:
        page = src.get(ids=[row_id], include=["documents", "metadatas"])
        dst.add(ids=page["ids"], documents=page["documents"], metadatas=page["metadatas"])
        return True
    except Exception:
        return False


def _copy_ids(src, dst, ids: list) -> tuple:
    """Copy the given ids; returns (copied, reembedded, lost_ids).

    Rows whose stored embedding is unreadable (the stale-id corruption can
    break the embedding fetch itself) are bisected down and re-added from
    their documents so chroma re-embeds them; rows whose document is also
    unreadable are reported as lost, never silently dropped.
    """
    copied, reembedded, lost = 0, 0, []

    def _copy_chunk(chunk: list) -> None:
        nonlocal copied, reembedded
        if not chunk:
            return
        if _try_with_embeddings(src, dst, chunk):
            copied += len(chunk)
        elif len(chunk) > 1:
            mid = len(chunk) // 2
            _copy_chunk(chunk[:mid])
            _copy_chunk(chunk[mid:])
        elif _recover_single(src, dst, chunk[0]):
            copied += 1
            reembedded += 1
        else:
            lost.append(chunk[0])

    for i in range(0, len(ids), BATCH):
        _copy_chunk(ids[i : i + BATCH])
    return copied, reembedded, lost


def _probe(col) -> str:
    """Return '' if the corruption-exposing query works, else the error."""
    try:
        col.query(query_texts=["probe"], n_results=3, where=PROBE_WHERE)
        return ""
    except Exception as exc:  # noqa: BLE001 — report any store error verbatim
        return str(exc)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="execute (default: dry-run)")
    args = parser.parse_args()

    _fix_blob_seq_ids(_config.palace_path)
    client = chromadb.PersistentClient(path=_config.palace_path)
    col = client.get_collection(COLLECTION)
    total = col.count()
    err = _probe(col)
    print(f"{COLLECTION}: {total} rows; probe {PROBE_WHERE}: {err or 'healthy'}")
    if not err:
        print("index is healthy — nothing to do")
        return 0
    if not args.apply:
        print(f"DRY RUN: would rebuild {COLLECTION} via {SCRATCH}. Re-run with --apply.")
        return 0

    try:
        client.delete_collection(SCRATCH)
    except Exception:
        pass
    scratch = client.create_collection(SCRATCH)
    ids = _all_ids(col)
    copied, reembedded, lost = _copy_ids(col, scratch, ids)
    if lost:
        print(
            f"ABORT: {len(lost)} row(s) unrecoverable (ids: {lost[:10]}...); "
            "original untouched, scratch left for inspection"
        )
        return 1
    if copied != total or scratch.count() != total:
        print(
            f"ABORT: copied {copied}/{total} (scratch holds {scratch.count()}); "
            f"original untouched, scratch left for inspection"
        )
        return 1
    scratch_err = _probe(scratch)
    if scratch_err:
        print(
            f"ABORT: scratch collection still fails the probe ({scratch_err}); "
            "original untouched"
        )
        return 1
    print(f"scratch rebuilt and healthy ({copied} rows, {reembedded} re-embedded) — swapping")

    client.delete_collection(COLLECTION)
    fresh = client.create_collection(COLLECTION)
    restored, _, lost_back = _copy_ids(scratch, fresh, _all_ids(scratch))
    if restored != total or lost_back:
        print(
            f"ERROR: restored only {restored}/{total} rows into {COLLECTION}; "
            f"full data still in {SCRATCH} — do not delete it"
        )
        return 1
    final_err = _probe(fresh)
    if final_err:
        print(
            f"ERROR: rebuilt {COLLECTION} still fails the probe ({final_err}); "
            f"data intact ({restored} rows), {SCRATCH} retained"
        )
        return 1
    client.delete_collection(SCRATCH)
    print(f"OK: {COLLECTION} rebuilt ({restored} rows), probe healthy, scratch dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
