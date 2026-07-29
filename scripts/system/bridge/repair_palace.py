#!/usr/bin/env python3
"""Repair a corrupted MemPalace ChromaDB vector index (in place, content-preserving).

WHY THIS EXISTS
    The palace's `chroma.sqlite3` stores every drawer's document text + metadata
    durably, but the vector search index lives in separate segment files
    (HNSW `*.bin`). If that index becomes corrupted or is written by an
    incompatible ChromaDB version, ChromaDB's native (rust) core can SEGFAULT on
    *every* collection op (count/get/add/query) — which the memory bridge then
    surfaces as an unrecoverable "Bridge exited with code null (signal SIGSEGV)".
    A retry can't fix a deterministic native crash.

WHAT THIS DOES
    Reads the intact documents + metadata straight from `chroma.sqlite3` via
    plain sqlite (no rust core, so it can't crash), re-adds them to a FRESH
    collection (ChromaDB's default embedding fn → deterministic identical
    vectors), verifies the rebuilt collection survives the ops that crashed, then
    atomically swaps it into place. Drawer content is preserved; only the vector
    index is rebuilt. Non-ChromaDB palace entries (e.g. `archive/`) are kept, and
    the Knowledge-Graph store (a separate sqlite) is never touched.

USAGE
    python scripts/system/bridge/repair_palace.py            # backup + rebuild + swap
    python scripts/system/bridge/repair_palace.py --dry-run  # rebuild + verify only, no swap
    MEMPALACE_PATH=/path/to/palace python scripts/system/bridge/repair_palace.py

Exit codes: 0 = repaired (or dry-run verified); 2 = nothing to do / no palace; 1 = error.
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import sys
import tarfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _resolve_palace() -> tuple[str, str]:
    """Return (palace_path, collection_name) from MempalaceConfig — the SAME
    source the bridge uses — so we always target the live palace, never a
    hardcoded location."""
    try:
        from mempalace.config import MempalaceConfig  # type: ignore

        cfg = MempalaceConfig()
        palace = str(cfg.palace_path)
        collection = getattr(cfg, "collection_name", None) or "mempalace_drawers"
        return palace, collection
    except Exception:
        # Fallback mirrors the bridge default; MEMPALACE_PATH still honored.
        base = os.environ.get("MEMPALACE_PATH") or os.path.join(Path.home(), ".mempalace")
        return base, "mempalace_drawers"


def _chroma_entries(palace: Path) -> list[Path]:
    """ChromaDB artifacts to replace: the sqlite (+ wal/shm) and UUID segment dirs."""
    out: list[Path] = []
    for p in palace.iterdir():
        if p.name.startswith("chroma.sqlite3") or (p.is_dir() and _UUID_RE.match(p.name)):
            out.append(p)
    return out


def _extract_records(sqlite_path: Path) -> tuple[list[str], list[str], list[dict | None]]:
    con = sqlite3.connect(str(sqlite_path))
    cur = con.cursor()
    cols = [r[1] for r in cur.execute("PRAGMA table_info(embedding_metadata)")]
    val_cols = [c for c in ("string_value", "int_value", "float_value", "bool_value") if c in cols]
    idmap = {r[0]: r[1] for r in cur.execute("SELECT id, embedding_id FROM embeddings")}
    meta: dict[int, dict] = defaultdict(dict)
    docs: dict[int, str] = {}
    sel = "SELECT id, key, " + ", ".join(val_cols) + " FROM embedding_metadata"
    for row in cur.execute(sel):
        eid, key, vals = row[0], row[1], row[2:]
        val = next((v for v in vals if v is not None), None)
        if key == "chroma:document":
            docs[eid] = val
        elif val is not None:
            meta[eid][key] = val
    con.close()

    ids: list[str] = []
    documents: list[str] = []
    metadatas: list[dict | None] = []
    seen: set[str] = set()
    for eid, chroma_id in idmap.items():
        doc = docs.get(eid)
        if not doc or chroma_id in seen:
            continue
        seen.add(chroma_id)
        md = {k: v for k, v in meta.get(eid, {}).items() if isinstance(v, (str, int, float, bool))}
        ids.append(chroma_id)
        documents.append(doc)
        metadatas.append(md or None)
    return ids, documents, metadatas


def _build(dest: Path, collection: str, ids, documents, metadatas) -> None:
    import chromadb  # imported late so a broken install fails with a clear message

    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    client = chromadb.PersistentClient(path=str(dest))
    col = client.get_or_create_collection(collection)
    B = 128
    for i in range(0, len(ids), B):
        col.add(ids=ids[i:i + B], documents=documents[i:i + B], metadatas=metadatas[i:i + B])
    # The exact ops that segfaulted on the corrupt collection must now succeed.
    n = col.count()
    col.get(limit=2)
    col.query(query_texts=["repair verification probe"], n_results=1)
    if n != len(ids):
        raise RuntimeError(f"rebuilt count {n} != expected {len(ids)}")


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    palace_str, collection = _resolve_palace()
    palace = Path(palace_str)
    sqlite_path = palace / "chroma.sqlite3"

    if not sqlite_path.exists():
        print(f"[repair] no chroma.sqlite3 at {palace} — nothing to repair.")
        return 2

    print(f"[repair] palace={palace}  collection={collection}")
    ids, documents, metadatas = _extract_records(sqlite_path)
    print(f"[repair] extracted {len(ids)} drawer records from chroma.sqlite3")
    if not ids:
        print("[repair] no records extracted — aborting (won't replace with an empty index).")
        return 1

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    staging = palace.parent / f"{palace.name}.rebuild_tmp"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    # Preserve every non-ChromaDB entry (e.g. archive/) in the staging palace.
    chroma_names = {p.name for p in _chroma_entries(palace)}
    for p in palace.iterdir():
        if p.name in chroma_names:
            continue
        (shutil.copytree if p.is_dir() else shutil.copy2)(p, staging / p.name)

    print(f"[repair] rebuilding fresh index into {staging} …")
    _build(staging, collection, ids, documents, metadatas)
    print(f"[repair] rebuilt + verified OK ({len(ids)} drawers, count/get/query all pass).")

    if dry_run:
        print(f"[repair] --dry-run: staging left at {staging}; live palace untouched.")
        return 0

    backup = palace.parent / f"{palace.name}.backup-{ts}.tgz"
    with tarfile.open(backup, "w:gz") as tf:
        tf.add(palace, arcname=palace.name)
    print(f"[repair] backed up live palace -> {backup}")

    corrupt_bak = palace.parent / f"{palace.name}.corrupt_bak-{ts}"
    os.replace(palace, corrupt_bak)   # atomic rename (same filesystem)
    os.replace(staging, palace)       # atomic rename
    print(f"[repair] swapped. old palace kept at {corrupt_bak}")

    # Final verification against the LIVE path.
    import chromadb
    col = chromadb.PersistentClient(path=str(palace)).get_collection(collection)
    print(f"[repair] LIVE verify: count={col.count()} — OK, no segfault.")
    print("[repair] DONE. Remove the .corrupt_bak-* / .backup-*.tgz once you're satisfied.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"[repair] ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
