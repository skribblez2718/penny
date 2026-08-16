#!/usr/bin/env python3
"""Diagnose a receipt-gated copied/offline ChromaDB palace.

This deliberately touches ONLY sqlite, read-only, and never imports chromadb or
opens a collection. That matters: when the vector index is in the crashing state
this script is describing, any chromadb collection call segfaults the process
(SIGSEGV, on reads AND writes). A diagnostic that dies alongside the thing it is
diagnosing is useless, so this one stays well clear of the native code path.

Emits a JSON object on stdout:

    {
      "ok": bool,              # False when a crash-prone condition is detected
      "verdict": str,          # one-line human summary
      "detail": [str, ...],    # supporting observations
      "action": str | null,    # concrete recommended next step
      "stats": {...}           # raw numbers
    }

Usage:
    python -m scripts.system.bridge.palace_doctor \\
      --offline-target /absolute/copied-palace \\
      --receipt /absolute/offline-receipt.json [--text]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Sequence

from scripts.system.bridge.fts5_integrity import probe_authorized_database
from scripts.system.memory.offline_access import authorize_offline_target

# Backlog sizes measured on the production palace, repeating each trial on
# byte-identical input (see HNSW_TUNING in memory_bridge.py):
#     0 -> 0/8 crashes   142 -> 0/5 crashes   162 -> 4/4   218 -> 5/5
# The triggering corpus was dominated by metadata-only UPDATEs (operation 1),
# followed by ADDs — NOT deletes. The cliff sits between 142 and 162, so warn
# with real margin below it.
WAL_WARN = 100
WAL_CRITICAL = 150


def _connect_ro(db: Path) -> sqlite3.Connection:
    """Read-only connection — never mutates, never checkpoints the caller's WAL."""
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def _scalar(conn: sqlite3.Connection, sql: str, default: int = 0) -> int:
    try:
        row = conn.execute(sql).fetchone()
        return int(row[0]) if row and row[0] is not None else default
    except sqlite3.Error:
        return default


def _segment_seqs(conn: sqlite3.Connection) -> tuple[int | None, int | None]:
    """Return (vector_seq, metadata_seq) — how far each segment has consumed."""
    try:
        seqs = {r[0]: r[1] for r in conn.execute("SELECT segment_id, seq_id FROM max_seq_id")}
        scopes = {r[1]: r[0] for r in conn.execute("SELECT id, scope FROM segments")}
    except sqlite3.Error:
        return None, None
    vector = scopes.get("VECTOR")
    metadata = scopes.get("METADATA")
    return (seqs.get(vector) if vector else None, seqs.get(metadata) if metadata else None)


def _hnsw_tuning(conn: sqlite3.Connection) -> dict[str, int]:
    try:
        return {
            key: val
            for key, val in conn.execute(
                "SELECT key, int_value FROM collection_metadata WHERE key LIKE 'hnsw:%'"
            )
        }
    except sqlite3.Error:
        return {}


def _read_state(db: Path) -> dict:
    """Collect the raw numbers that describe palace health."""
    with _connect_ro(db) as conn:
        vec_seq, meta_seq = _segment_seqs(conn)
        tuning = _hnsw_tuning(conn)
        return {
            "drawers": _scalar(conn, "SELECT COUNT(*) FROM embeddings"),
            "wal_backlog": _scalar(conn, "SELECT COUNT(*) FROM embeddings_queue"),
            # ChromaDB persisted operation codes:
            #   0 ADD, 1 UPDATE, 2 UPSERT, 3 DELETE
            "wal_adds": _scalar(conn, "SELECT COUNT(*) FROM embeddings_queue WHERE operation = 0"),
            "wal_updates": _scalar(
                conn, "SELECT COUNT(*) FROM embeddings_queue WHERE operation = 1"
            ),
            "wal_upserts": _scalar(
                conn, "SELECT COUNT(*) FROM embeddings_queue WHERE operation = 2"
            ),
            "wal_deletes": _scalar(
                conn, "SELECT COUNT(*) FROM embeddings_queue WHERE operation = 3"
            ),
            "vector_segment_seq": vec_seq,
            "metadata_segment_seq": meta_seq,
            "segment_drift": (
                meta_seq - vec_seq if vec_seq is not None and meta_seq is not None else None
            ),
            "hnsw_tuning": tuning,
            "sync_threshold": tuning.get("hnsw:sync_threshold"),
        }


def _observations(stats: dict) -> list[str]:
    detail = [
        f"{stats['drawers']} drawers indexed; "
        f"{stats['wal_backlog']} record(s) pending in the vector WAL"
    ]
    if stats["segment_drift"] is not None:
        detail.append(
            f"vector index is {stats['segment_drift']} record(s) behind metadata "
            f"(vector seq {stats['vector_segment_seq']}, "
            f"metadata seq {stats['metadata_segment_seq']})"
        )
    if stats["wal_backlog"]:
        detail.append(
            "pending WAL is "
            f"{stats['wal_adds']} add(s) / {stats['wal_updates']} update(s) / "
            f"{stats['wal_upserts']} upsert(s) / {stats['wal_deletes']} delete(s)"
        )
    return detail


def _judge(stats: dict) -> tuple[bool, str, str | None, list[str]]:
    """Turn raw numbers into a verdict. Returns (ok, verdict, action, extra_detail)."""
    backlog = stats["wal_backlog"]

    if stats["sync_threshold"] is None:
        return (
            False,
            "Palace is running unbounded-WAL configuration — recurrence is guaranteed.",
            "One-time migration: python scripts/system/bridge/repair_palace.py "
            "(rebuilds the collection WITH bounded-WAL settings; drawer content preserved).",
            [
                "collection has NO hnsw:sync_threshold — it was created with the stock "
                "default (1000). Under a short-lived per-call bridge, metadata-only update "
                "bursts can accumulate a large replay backlog before persistence catches up"
            ],
        )

    if backlog >= WAL_CRITICAL:
        return (
            False,
            f"WAL backlog {backlog} is in the measured crash range (>= {WAL_CRITICAL}) — "
            "queries and writes may SIGSEGV.",
            "Compaction is not keeping up. Check for recall-metadata UPDATE bursts or other "
            "high-churn writers, and "
            f"consider lowering hnsw:sync_threshold (currently {stats['sync_threshold']}).",
            [],
        )

    if backlog >= WAL_WARN:
        return (
            True,
            f"WAL backlog {backlog} is elevated but below the measured crash range.",
            "Watch it; if it keeps climbing, compaction is not keeping up.",
            [],
        )

    return (True, "Palace healthy — bounded-WAL config active and backlog is small.", None, [])


def diagnose(offline_target: Path, receipt: Path) -> dict:
    authorization = authorize_offline_target(offline_target, receipt)
    palace = authorization.target
    collection = "mempalace_drawers"
    db = palace / "chroma.sqlite3"
    stats: dict = {
        "palace": str(palace),
        "collection": collection,
        "offline_source_id": authorization.source_id,
    }

    if not db.is_file():
        return {
            "ok": False,
            "verdict": "No chroma.sqlite3 found — palace is missing or not initialized.",
            "detail": [f"looked for {db}"],
            "action": "Verify the explicit copied/offline target and its receipt.",
            "stats": stats,
        }

    integrity = probe_authorized_database(authorization)
    stats["sqlite_integrity"] = integrity.to_dict()
    if not integrity.repair_safe:
        return {
            "ok": False,
            "verdict": "Unclassified SQLite corruption detected — repair/rebuild is blocked.",
            "detail": [
                "the integrity probe ran FTS5 and SQLite checks only on a temporary copy",
                "findings are typed and contain no database content",
            ],
            "action": "Preserve the copied target and obtain classified offline recovery evidence.",
            "stats": stats,
        }
    if integrity.corrupt_fts5_tables:
        return {
            "ok": False,
            "verdict": "Classified FTS5 index corruption detected on the temporary probe copy.",
            "detail": [
                "source database bytes were unchanged by the probe",
                "the FTS5 index is derived and eligible for receipt-gated offline rebuild",
            ],
            "action": "Run scripts.system.bridge.repair_palace with --fts5-only first; "
            "add --apply only for the authorized copied target.",
            "stats": stats,
        }

    stats.update(_read_state(db))
    ok, verdict, action, extra = _judge(stats)
    return {
        "ok": ok,
        "verdict": verdict,
        "detail": _observations(stats) + extra,
        "action": action,
        "stats": stats,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--offline-target", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--text", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = diagnose(args.offline_target, args.receipt)
    except Exception as exc:  # never let the doctor itself blow up the caller
        result = {
            "ok": False,
            "verdict": f"palace_doctor failed to inspect the palace: {exc}",
            "detail": [],
            "action": None,
            "stats": {},
        }

    if args.text:
        print(result["verdict"])
        for line in result["detail"]:
            print(f"  - {line}")
        if result.get("action"):
            print(f"  → {result['action']}")
    else:
        print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
