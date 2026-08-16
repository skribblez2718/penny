#!/usr/bin/env python3
"""Break-glass rebuild of a receipt-gated copied/offline vector index.

READ THIS BEFORE RUNNING IT
    This is NOT the routine answer to a crashing palace, and it used to be sold
    as exactly that. Running it in a loop is what kept the failure alive:
    it rebuilt the collection with ChromaDB's STOCK defaults, which is the very
    configuration that guarantees the crash comes back. It papered over the
    symptom and re-armed the cause on the way out.

    The actual defect and its fix are documented at HNSW_TUNING in
    scripts/system/bridge/memory_bridge.py. In short: ChromaDB documents its
    SQLite embeddings queue as suitable only when producer and consumer share
    one process (notification is in-process), while the bridge starts a fresh
    short-lived process per call. With stock `sync_threshold=1000`, metadata-only
    recall UPDATEs and ADDs accumulate while HNSW persistence lags. Historical
    byte-identical production corpora prove that sufficiently large UPDATE+ADD
    replay backlogs — with ZERO pending deletes and byte-exact index files — can
    trip a NULL-deref inside chromadb_rust_bindings (upstream bug, unfixed as of
    1.5.9 — the latest release). The process SIGSEGVs on reads and writes, and
    the palace wedges because the replay that would advance HNSW itself crashes.

WHEN TO RUN IT
    1. ONE-TIME MIGRATION. ChromaDB honors HNSW settings only at collection
       CREATION — `collection.modify()` is accepted, is persisted to
       `collection_metadata`, and is then ignored by the Rust core (verified).
       So an existing collection created without bounded-WAL settings can only be
       fixed by rebuilding it, which is what this does.
    2. BREAK-GLASS. A genuinely damaged segment (truncated flush, unreadable
       index files) still needs a rebuild from sqlite.

    Run the receipt-gated ``scripts.system.bridge.palace_doctor`` first. It reports the
    real state (WAL backlog, segment drift, whether bounded-WAL config is
    active) and is safe to run while the palace is wedged. If it says the
    palace is healthy, this script is not your answer — find the real fault.

WHAT THIS DOES
    Before either repair path, runs SQLite/FTS5 integrity checks only against a
    temporary copy. Unclassified corruption blocks repair. With `--fts5-only`,
    rebuilds only classified FTS5 derived indexes on the receipt-authorized
    copied database and verifies them through a fresh temporary-copy probe.

    The default full rebuild reads intact documents + metadata straight from
    `chroma.sqlite3` via
    plain sqlite (no rust core, so it can't crash), re-adds them to a FRESH
    collection created WITH the bounded-WAL settings (ChromaDB's default
    embedding fn → deterministic identical vectors), verifies the rebuilt
    collection survives the ops that crashed, then atomically swaps it into
    place. Drawer content is preserved; only the vector index is rebuilt.
    Non-ChromaDB palace entries (e.g. `archive/`) are kept, and the
    Knowledge-Graph store (a separate sqlite) is never touched.

USAGE
    python -m scripts.system.bridge.repair_palace \\
      --offline-target /absolute/copied-palace \\
      --receipt /absolute/offline-receipt.json             # rebuild + verify only
    python -m scripts.system.bridge.repair_palace ... --apply  # swap inside the copy
    python -m scripts.system.bridge.repair_palace ... --fts5-only          # inspect
    python -m scripts.system.bridge.repair_palace ... --fts5-only --apply  # rebuild FTS5

Exit codes: 0 = verified/rebuilt copy; 2 = no copied database; 1 = error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tarfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence, cast

from scripts.system.bridge.fts5_integrity import (
    IntegrityReport,
    _quote_identifier,
    probe_authorized_database,
)
from scripts.system.memory.hnsw import HNSW_TUNING
from scripts.system.memory.offline_access import OfflineAuthorization, authorize_offline_target

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _chroma_entries(palace: Path) -> list[Path]:
    """ChromaDB artifacts to replace: the sqlite (+ wal/shm) and UUID segment dirs."""
    out: list[Path] = []
    for p in palace.iterdir():
        if p.name.startswith("chroma.sqlite3") or (p.is_dir() and _UUID_RE.match(p.name)):
            out.append(p)
    return out


def _extract_records(sqlite_path: Path) -> tuple[list[str], list[str], list[dict | None]]:
    con = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
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
        if key == "chroma:document" and isinstance(val, str):
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


def _hnsw_tuning() -> dict[str, int]:
    """Return the creation-time settings shared by offline recovery tools."""

    return dict(HNSW_TUNING)


def _verify_tuning(dest: Path, tuning: dict[str, int]) -> dict[str, int]:
    """Confirm the bounded-WAL settings actually landed in the rebuilt palace.

    A rebuild that silently drops them reproduces the exact fault the rebuild was
    run to clear, so this fails loudly rather than shipping a time bomb.
    """
    with sqlite3.connect(f"file:{dest / 'chroma.sqlite3'}?mode=ro", uri=True) as conn:
        stored: dict[str, int] = {
            str(key): int(value)
            for key, value in conn.execute(
                "SELECT key, int_value FROM collection_metadata WHERE key LIKE 'hnsw:%'"
            )
        }
    missing = {k: v for k, v in tuning.items() if stored.get(k) != v}
    if missing:
        raise RuntimeError(
            f"rebuilt collection did not persist HNSW tuning {missing} (stored: {stored}); "
            "refusing to swap in a palace that would re-accumulate an unbounded WAL"
        )
    print(f"[repair] bounded-WAL settings verified on rebuild: {stored}")
    return stored


def _build(
    dest: Path,
    collection: str,
    ids: list[str],
    documents: list[str],
    metadatas: list[dict | None],
) -> None:
    import chromadb  # imported late so a broken install fails with a clear message

    tuning = _hnsw_tuning()
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    client = chromadb.PersistentClient(path=str(dest))
    # metadata= is load-bearing and must be set HERE, at creation: ChromaDB
    # ignores these keys when applied later via collection.modify().
    col = client.get_or_create_collection(collection, metadata=tuning)
    B = 128
    for i in range(0, len(ids), B):
        col.add(
            ids=ids[i : i + B],
            documents=documents[i : i + B],
            metadatas=cast(Any, metadatas[i : i + B]),
        )
    # The exact ops that segfaulted on the corrupt collection must now succeed.
    n = col.count()
    col.get(limit=2)
    col.query(query_texts=["repair verification probe"], n_results=1)
    if n != len(ids):
        raise RuntimeError(f"rebuilt count {n} != expected {len(ids)}")
    _verify_tuning(dest, tuning)


@dataclass(frozen=True)
class Fts5RepairResult:
    """Content-free outcome of the isolated FTS5 offline repair path."""

    outcome: str
    applied: bool
    tables: tuple[str, ...]
    preflight: IntegrityReport
    postflight: IntegrityReport | None = None
    backup_name: str | None = None

    @property
    def passed(self) -> bool:
        return self.outcome in {"clean", "dry-run", "repaired"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "repair_type": "receipt-gated-offline-fts5-rebuild",
            "passed": self.passed,
            "outcome": self.outcome,
            "applied": self.applied,
            "tables": list(self.tables),
            "backup_name": self.backup_name,
            "preflight": self.preflight.to_dict(),
            "postflight": self.postflight.to_dict() if self.postflight else None,
            "content_included": False,
        }


def _backup_sqlite(database: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = database.with_name(f"{database.name}.pre-fts5-repair-{timestamp}")
    if backup.exists() or backup.is_symlink():
        raise RuntimeError(f"refusing to overwrite SQLite backup: {backup.name}")
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as source:
        with sqlite3.connect(backup) as destination:
            source.backup(destination)
    backup.chmod(0o600)
    return backup


def _rebuild_fts5_tables(database: Path, tables: tuple[str, ...]) -> None:
    with sqlite3.connect(database, isolation_level=None) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            for table in tables:
                identifier = _quote_identifier(table)
                statement = f"INSERT INTO {identifier} ({identifier}) VALUES (?)"
                connection.execute(statement, ("rebuild",))
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise


def _repair_fts5_authorized(
    authorization: OfflineAuthorization,
    *,
    apply: bool,
) -> Fts5RepairResult:
    preflight = probe_authorized_database(authorization)
    tables = preflight.corrupt_fts5_tables
    if not preflight.repair_safe:
        return Fts5RepairResult("blocked-unclassified-corruption", False, tables, preflight)
    if not tables:
        return Fts5RepairResult("clean", False, (), preflight)
    if not apply:
        return Fts5RepairResult("dry-run", False, tables, preflight)

    database = authorization.target / "chroma.sqlite3"
    backup: Path | None = None
    try:
        backup = _backup_sqlite(database)
        _rebuild_fts5_tables(database, tables)
    except (OSError, RuntimeError, sqlite3.Error):
        return Fts5RepairResult(
            "repair-failed",
            True,
            tables,
            preflight,
            backup_name=backup.name if backup else None,
        )

    postflight = probe_authorized_database(authorization)
    outcome = "repaired" if postflight.ok else "verification-failed"
    return Fts5RepairResult(
        outcome,
        True,
        tables,
        preflight,
        postflight,
        backup.name if backup else None,
    )


def repair_fts5_indexes(
    offline_target: Path,
    receipt: Path,
    *,
    apply: bool = False,
) -> Fts5RepairResult:
    """Repair only classified FTS5 corruption in a receipt-authorized copy."""

    authorization = authorize_offline_target(offline_target, receipt)
    return _repair_fts5_authorized(authorization, apply=apply)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--offline-target", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument(
        "--apply", action="store_true", help="apply the selected repair inside the copy"
    )
    parser.add_argument(
        "--fts5-only",
        action="store_true",
        help="rebuild only classified corrupt FTS5 indexes in the copied database",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    authorization = authorize_offline_target(args.offline_target, args.receipt)
    palace = authorization.target
    collection = "mempalace_drawers"
    sqlite_path = palace / "chroma.sqlite3"

    if not sqlite_path.exists():
        print(f"[repair] no chroma.sqlite3 at {palace} — nothing to repair.")
        return 2

    if args.fts5_only:
        fts5_result = _repair_fts5_authorized(authorization, apply=args.apply)
        print(json.dumps(fts5_result.to_dict(), indent=2))
        return 0 if fts5_result.passed else 1

    integrity = probe_authorized_database(authorization)
    if not integrity.repair_safe:
        print("[repair] blocked: temporary-copy integrity probe found unclassified corruption.")
        print(json.dumps(integrity.to_dict(), indent=2))
        return 1
    if integrity.corrupt_fts5_tables:
        print(
            "[repair] classified FTS5 index corruption detected on the temporary probe copy; "
            "full copied-palace rebuild may proceed."
        )

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

    if not args.apply:
        print(f"[repair] dry run: staging left at {staging}; copied target untouched.")
        return 0

    backup = palace.parent / f"{palace.name}.backup-{ts}.tgz"
    with tarfile.open(backup, "w:gz") as tf:
        tf.add(palace, arcname=palace.name)
    print(f"[repair] backed up live palace -> {backup}")

    corrupt_bak = palace.parent / f"{palace.name}.corrupt_bak-{ts}"
    os.replace(palace, corrupt_bak)  # atomic rename (same filesystem)
    os.replace(staging, palace)  # atomic rename
    print(f"[repair] swapped. old palace kept at {corrupt_bak}")

    # Final verification against the swapped copied/offline target.
    import chromadb

    col = chromadb.PersistentClient(path=str(palace)).get_collection(collection)
    print(f"[repair] copied-target verify: count={col.count()} — OK, no segfault.")
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
