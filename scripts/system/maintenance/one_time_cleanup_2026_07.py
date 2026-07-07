#!/usr/bin/env python3
"""One-time MemPalace cleanup (2026-07).

Heals the accreted store audited in July 2026: it canonicalizes the
``wing_penny`` / ``penny`` split, purges test-junk wings and signals, backfills
the new lifecycle metadata (``recall_count`` / ``last_recalled_at`` / ``type``)
onto legacy drawers so decay and telemetry work uniformly, drops the three
orphan ChromaDB collections, removes the dead shadow stores, and VACUUMs.

SAFE BY DEFAULT — runs as a DRY RUN (reports what it would do, changes nothing).
Pass ``--apply`` to mutate. ALWAYS back up first::

    cp -r .mempalace .mempalace.bak.$(date +%F)
    python scripts/system/maintenance/one_time_cleanup_2026_07.py            # dry run
    python scripts/system/maintenance/one_time_cleanup_2026_07.py --apply    # execute

Idempotent: re-running after --apply is a no-op (nothing left to migrate).
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from pathlib import Path

_BRIDGE_DIR = Path(__file__).resolve().parents[1] / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

import memory_bridge as mb  # noqa: E402
import chromadb  # noqa: E402

MAIN_COLLECTION = "mempalace_drawers"
ORPHAN_COLLECTIONS = ("penny_memories", "mempalace", "knowledge_graph")
_BATCH = 1000

# Infer a drawer `type` from its room / id when the metadata lacks one.
_ROOM_TYPE = {
    "signals": "signal",
    "outcomes": "outcome",
    "system_amendments": "amendment",
    "digests": "digest",
    "diary": "diary_entry",
}


def _infer_type(meta: dict) -> str:
    if meta.get("type"):
        return str(meta["type"])
    room = meta.get("room", "")
    if room in _ROOM_TYPE:
        return _ROOM_TYPE[room]
    return "general"


def _chunks(seq, n=_BATCH):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def _log(msg: str) -> None:
    print(msg, flush=True)


def migrate_wings(col, apply: bool) -> int:
    """wing_penny (+ Ring/Wing variants) → canonical 'penny'."""
    got = col.get(where={"wing": "wing_penny"}, include=["metadatas"])
    ids = got.get("ids", [])
    if ids and apply:
        for id_batch, meta_batch in zip(_chunks(ids), _chunks(got["metadatas"])):
            new_metas = [{**(m or {}), "wing": "penny"} for m in meta_batch]
            col.update(ids=list(id_batch), metadatas=new_metas)
    _log(f"[wings]     wing_penny → penny: {len(ids)} drawers")
    return len(ids)


def purge_test_junk(col, apply: bool) -> int:
    """Delete every drawer under a test wing (wing_test-*) plus leaked test signals."""
    all_meta = col.get(include=["metadatas"])
    ids = all_meta.get("ids", [])
    metas = all_meta.get("metadatas", [])
    to_delete = []
    for did, m in zip(ids, metas):
        wing = (m or {}).get("wing", "")
        if wing.startswith("wing_test") or wing.startswith("wing_test-"):
            to_delete.append(did)
    # Leaked test signals in the real signals room (by id prefix).
    for did in ids:
        low = did.lower()
        if any(
            t in low for t in ("dup_test", "multi1_", "multi2_", "signal_int_test", "test.entry")
        ):
            if did not in to_delete:
                to_delete.append(did)
    if to_delete and apply:
        for batch in _chunks(to_delete):
            col.delete(ids=list(batch))
    _log(f"[test-junk] delete: {len(to_delete)} drawers")
    return len(to_delete)


def backfill_metadata(col, apply: bool) -> int:
    """Add recall_count/last_recalled_at/type to legacy drawers missing them."""
    all_meta = col.get(include=["metadatas"])
    ids = all_meta.get("ids", [])
    metas = all_meta.get("metadatas", [])
    upd_ids, upd_metas = [], []
    for did, m in zip(ids, metas):
        m = m or {}
        if "recall_count" in m and "type" in m and "last_recalled_at" in m:
            continue
        nm = dict(m)
        nm.setdefault("recall_count", 0)
        nm.setdefault("last_recalled_at", "")
        nm["type"] = _infer_type(m)
        upd_ids.append(did)
        upd_metas.append(nm)
    if upd_ids and apply:
        for id_batch, meta_batch in zip(_chunks(upd_ids), _chunks(upd_metas)):
            col.update(ids=list(id_batch), metadatas=list(meta_batch))
    _log(f"[backfill]  lifecycle metadata: {len(upd_ids)} drawers")
    return len(upd_ids)


def drop_orphan_collections(client, apply: bool) -> int:
    """Delete the three never-used collections (keep mempalace_drawers)."""
    try:
        existing = {c.name for c in client.list_collections()}
    except Exception as exc:
        _log(f"[orphans]   could not list collections: {exc}")
        return 0
    dropped = 0
    for name in ORPHAN_COLLECTIONS:
        if name in existing:
            if apply:
                try:
                    client.delete_collection(name)
                except Exception as exc:
                    _log(f"[orphans]   failed to drop {name}: {exc}")
                    continue
            _log(f"[orphans]   drop collection: {name}")
            dropped += 1
    if not dropped:
        _log("[orphans]   no orphan collections present")
    return dropped


def remove_shadow_stores(palace_path: Path, apply: bool) -> int:
    """Remove the 0-byte repo KG file and the stale palace/ sub-store."""
    removed = 0
    kg = palace_path / "knowledge_graph.sqlite3"
    if kg.exists() and kg.stat().st_size == 0:
        if apply:
            kg.unlink()
        _log(f"[shadow]    remove 0-byte {kg.name}")
        removed += 1
    stale_palace = palace_path / "palace"
    if stale_palace.is_dir():
        if apply:
            shutil.rmtree(stale_palace, ignore_errors=True)
        _log(f"[shadow]    remove stale {stale_palace}/")
        removed += 1
    if not removed:
        _log("[shadow]    no shadow stores present")
    return removed


def vacuum(palace_path: Path, apply: bool) -> None:
    db = palace_path / "chroma.sqlite3"
    if not db.exists():
        return
    before = db.stat().st_size
    if apply:
        con = sqlite3.connect(str(db))
        try:
            con.execute("VACUUM")
            con.commit()
        finally:
            con.close()
        after = db.stat().st_size
        _log(f"[vacuum]    {before // 1024}KB → {after // 1024}KB")
    else:
        _log(f"[vacuum]    would VACUUM chroma.sqlite3 (currently {before // 1024}KB)")


def main() -> int:
    parser = argparse.ArgumentParser(description="One-time MemPalace cleanup (2026-07).")
    parser.add_argument("--apply", action="store_true", help="Execute (default: dry run).")
    parser.add_argument("--palace", default=str(mb._config.palace_path), help="Palace path.")
    args = parser.parse_args()

    palace_path = Path(args.palace)
    mode = "APPLY" if args.apply else "DRY RUN"
    _log(f"=== MemPalace cleanup ({mode}) — palace: {palace_path} ===")
    if not args.apply:
        _log("No changes will be made. Re-run with --apply after backing up:")
        _log(f"    cp -r {palace_path} {palace_path}.bak.YYYY-MM-DD")
    _log("")

    mb._fix_blob_seq_ids(str(palace_path))
    client = chromadb.PersistentClient(path=str(palace_path))
    try:
        col = client.get_collection(MAIN_COLLECTION)
    except Exception as exc:
        _log(f"ERROR: cannot open {MAIN_COLLECTION}: {exc}")
        return 1

    before = col.count()
    _log(f"[start]     mempalace_drawers: {before} drawers\n")

    migrate_wings(col, args.apply)
    purge_test_junk(col, args.apply)
    backfill_metadata(col, args.apply)
    drop_orphan_collections(client, args.apply)
    remove_shadow_stores(palace_path, args.apply)
    vacuum(palace_path, args.apply)

    if args.apply:
        _log(f"\n[done]      mempalace_drawers: {col.count()} drawers")
    else:
        _log("\n[done]      dry run complete — no changes made.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
