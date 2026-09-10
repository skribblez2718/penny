#!/usr/bin/env python3
"""Break-glass repair of a receipt-gated copied/offline palace.

Preview is inspection-only.  It may read receipt-authorized SQLite and use the
separate private temporary-copy FTS5 probe, but it never opens ChromaDB, builds
an index, allocates recovery staging, deletes, renames, swaps, or cleans up.

``--apply`` allocates one private unique preserved attempt.  The default full
repair re-embeds documents and therefore additionally requires the explicit
``--allow-reembedding`` decision; it is not an exact-vector substitute.  Use
``rebuild_from_disk`` with its separate legacy-metadata trust contract when
exact vectors are required.  FTS5-only apply rebuilds only the classified
derived index in staging.

Both apply paths verify staging before swap, verify again after swap, and restore
the exact parked source on failure.  Attempts and rollback evidence are never
automatically cleaned up.  A reported backup path is advisory and is paired
with exact parent/original/parked identities for fail-closed reacquisition.
``open_authorized_recovery`` retains the validated filesystem descriptors after
delegating receipt semantics to ``authorize_offline_target``.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence, cast

from scripts.system.bridge.fts5_integrity import (
    IntegrityReport,
    _quote_identifier,
    materialize_sqlite_family,
    probe_authorized_database,
    probe_database_directory,
    sqlite_budget_guard,
)
from scripts.system.bridge.recovery_safety import (
    BackupEvidence,
    HeldDirectory,
    RecoveryBudget,
    RecoverySource,
    RecoveryRefusal,
    RecoverySwapError,
    SourceSnapshot,
    VerificationResult,
    account_staging_tree,
    allocate_recovery_attempt,
    assert_source_unchanged,
    copy_preserved_entries,
    hold_private_regular_file,
    open_authorized_recovery,
    recovery_attempt_binding,
    revalidate_source_binding,
    snapshot_source_tree,
    swap_staged_palace,
)
from scripts.system.memory.common import ValidationError
from scripts.system.memory.hnsw import HNSW_TUNING

COLLECTION = "mempalace_drawers"
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

MetadataValue = str | int | float | bool


def _chroma_entry_names(snapshot: SourceSnapshot) -> frozenset[str]:
    """Return top-level Chroma artifact names from the exact source snapshot."""

    names: set[str] = set()
    for member in snapshot.members:
        name = member.relative_path
        if name == "." or "/" in name:
            continue
        if name.startswith("chroma.sqlite3") or (
            member.kind == "directory" and _UUID_RE.fullmatch(name)
        ):
            names.add(name)
    return frozenset(names)


def _metadata_value(values: Sequence[object]) -> MetadataValue | None:
    value = next((candidate for candidate in values if candidate is not None), None)
    if isinstance(value, bool):
        return value
    if isinstance(value, (str, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValidationError("copied palace metadata contains a non-finite float")
        return value
    if value is not None:
        raise ValidationError("copied palace metadata contains an unsupported value")
    return None


def _read_record_rows(
    connection: sqlite3.Connection,
) -> tuple[dict[int, str], dict[int, str], dict[int, dict[str, MetadataValue]]]:
    columns = [str(row[1]) for row in connection.execute("PRAGMA table_info(embedding_metadata)")]
    value_columns = [
        column
        for column in ("string_value", "int_value", "float_value", "bool_value")
        if column in columns
    ]
    id_map: dict[int, str] = {}
    for raw_id, raw_embedding_id in connection.execute("SELECT id, embedding_id FROM embeddings"):
        if not isinstance(raw_id, int) or not isinstance(raw_embedding_id, str):
            raise ValidationError("copied palace contains an invalid embedding identity")
        id_map[raw_id] = raw_embedding_id

    documents: dict[int, str] = {}
    metadata: dict[int, dict[str, MetadataValue]] = defaultdict(dict)
    selection = "SELECT id, key, " + ", ".join(value_columns) + " FROM embedding_metadata"
    for row in connection.execute(selection):
        raw_id, raw_key = row[0], row[1]
        if not isinstance(raw_id, int) or not isinstance(raw_key, str):
            raise ValidationError("copied palace contains invalid metadata identity")
        value = _metadata_value(row[2:])
        if raw_key == "chroma:document":
            if not isinstance(value, str):
                raise ValidationError("copied palace contains a non-string document")
            documents[raw_id] = value
        elif value is not None:
            metadata[raw_id][raw_key] = value
    return id_map, documents, metadata


def _extract_records(
    sqlite_path: Path,
    budget: RecoveryBudget | None = None,
) -> tuple[list[str], list[str], list[dict[str, MetadataValue] | None]]:
    """Read records from an already private descriptor-rooted SQLite copy."""

    operation_budget = budget if budget is not None else RecoveryBudget()
    with sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True) as connection:
        with sqlite_budget_guard(connection, operation_budget):
            id_map, documents_by_row, metadata_by_row = _read_record_rows(connection)

    ids: list[str] = []
    documents: list[str] = []
    metadata: list[dict[str, MetadataValue] | None] = []
    seen: set[str] = set()
    for row_id, chroma_id in id_map.items():
        document = documents_by_row.get(row_id)
        if document is None or chroma_id in seen:
            continue
        seen.add(chroma_id)
        record_metadata = dict(metadata_by_row.get(row_id, {}))
        ids.append(chroma_id)
        documents.append(document)
        metadata.append(record_metadata or None)
    return ids, documents, metadata


def _hnsw_tuning() -> dict[str, int]:
    """Return the creation-time settings shared by offline recovery tools."""

    return dict(HNSW_TUNING)


def _verify_tuning_database(
    database: Path,
    tuning: dict[str, int],
    budget: RecoveryBudget,
) -> dict[str, int]:
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        with sqlite_budget_guard(connection, budget):
            stored: dict[str, int] = {
                str(key): int(value)
                for key, value in connection.execute(
                    "SELECT key, int_value FROM collection_metadata WHERE key LIKE 'hnsw:%'"
                )
            }
    missing = {key: value for key, value in tuning.items() if stored.get(key) != value}
    if missing:
        raise RuntimeError(
            f"rebuilt collection did not persist HNSW tuning {missing} (stored: {stored}); "
            "refusing to swap in a palace that would re-accumulate an unbounded WAL"
        )
    print(f"[repair] bounded-WAL settings verified on rebuild: {stored}")
    return stored


def _verify_tuning(
    dest: Path,
    tuning: dict[str, int],
    budget: RecoveryBudget | None = None,
) -> dict[str, int]:
    """Compatibility helper for a caller-owned private rebuild directory."""

    operation_budget = budget if budget is not None else RecoveryBudget()
    return _verify_tuning_database(dest / "chroma.sqlite3", tuning, operation_budget)


def _build(
    dest: HeldDirectory | Path,
    collection: str,
    ids: list[str],
    documents: list[str],
    metadatas: list[dict[str, MetadataValue] | None],
    *,
    embedding_function: object | None = None,
) -> None:
    """Build a re-embedded collection in held private staging."""

    destination = dest.access_path if isinstance(dest, HeldDirectory) else dest
    budget = dest.budget if isinstance(dest, HeldDirectory) else RecoveryBudget()
    budget.checkpoint()
    if not isinstance(dest, HeldDirectory) and destination.is_symlink():
        raise ValidationError("repair staging must not be a symlink")
    if not destination.exists():
        destination.mkdir(mode=0o700)
    if not destination.is_dir() or any(
        path.name.startswith("chroma.sqlite3") for path in destination.iterdir()
    ):
        raise ValidationError("repair staging already contains Chroma state")

    import chromadb  # imported only after apply authorization

    tuning = _hnsw_tuning()
    client = chromadb.PersistentClient(path=str(destination))
    if isinstance(dest, HeldDirectory):
        account_staging_tree(dest)
    if embedding_function is None:
        rebuilt = client.get_or_create_collection(collection, metadata=tuning)
    else:
        # Narrow test/operations adapter: the runtime protocol is validated by Chroma.
        rebuilt = client.get_or_create_collection(
            collection,
            metadata=tuning,
            embedding_function=cast(Any, embedding_function),
        )
    batch_size = 128
    for index in range(0, len(ids), batch_size):
        budget.checkpoint()
        rebuilt.add(
            ids=ids[index : index + batch_size],
            documents=documents[index : index + batch_size],
            # Narrow third-party adapter: Chroma accepts optional metadata entries,
            # while its installed annotations do not expose that exact legacy shape.
            metadatas=cast(Any, metadatas[index : index + batch_size]),
        )
        if isinstance(dest, HeldDirectory):
            account_staging_tree(dest)
    count: object = rebuilt.count()
    if count != len(ids):
        raise RuntimeError(f"rebuilt count {count} != expected {len(ids)}")
    rebuilt.get(limit=2)
    rebuilt.query(query_texts=["repair verification probe"], n_results=1)
    if isinstance(dest, HeldDirectory):
        with materialize_sqlite_family(dest, account_as_input=False) as copied_database:
            _verify_tuning_database(copied_database, tuning, budget)
    else:
        _verify_tuning(destination, tuning, budget)


def _content_signature(
    ids: Sequence[str],
    documents: Sequence[str],
    metadatas: Sequence[dict[str, MetadataValue] | None],
) -> tuple[tuple[str, str, tuple[tuple[str, MetadataValue], ...]], ...]:
    rows = [
        (record_id, document, tuple(sorted((metadata or {}).items())))
        for record_id, document, metadata in zip(ids, documents, metadatas)
    ]
    return tuple(sorted(rows, key=lambda row: row[0]))


def _verify_full_rebuild(
    palace: HeldDirectory | Path,
    ids: Sequence[str],
    documents: Sequence[str],
    metadatas: Sequence[dict[str, MetadataValue] | None],
) -> VerificationResult:
    path = palace.access_path if isinstance(palace, HeldDirectory) else palace
    budget = palace.budget if isinstance(palace, HeldDirectory) else RecoveryBudget()
    try:
        if isinstance(palace, HeldDirectory):
            with materialize_sqlite_family(
                palace,
                account_as_input=False,
            ) as copied_database:
                actual_ids, actual_documents, actual_metadata = _extract_records(
                    copied_database,
                    budget,
                )
                _verify_tuning_database(copied_database, _hnsw_tuning(), budget)
        else:
            actual_ids, actual_documents, actual_metadata = _extract_records(
                path / "chroma.sqlite3",
                budget,
            )
        if _content_signature(actual_ids, actual_documents, actual_metadata) != _content_signature(
            ids, documents, metadatas
        ):
            return VerificationResult(False, "record IDs/documents/metadata differ after rebuild")
        if isinstance(palace, HeldDirectory) and not probe_database_directory(palace).ok:
            return VerificationResult(False, "rebuilt SQLite/FTS5 integrity failed")
        if not isinstance(palace, HeldDirectory):
            _verify_tuning(path, _hnsw_tuning(), budget)
        import chromadb

        budget.checkpoint()
        collection = chromadb.PersistentClient(path=str(path)).get_collection(COLLECTION)
        if collection.count() != len(ids):
            return VerificationResult(False, "rebuilt Chroma count differs")
        collection.get(limit=min(2, len(ids)))
        collection.query(query_texts=["repair verification probe"], n_results=1)
        budget.checkpoint()
    except RecoveryRefusal:
        raise
    except Exception as exc:  # third-party/native verification boundary
        return VerificationResult(False, f"Chroma verification failed: {type(exc).__name__}")
    return VerificationResult(True, f"record content/count/query verified ({len(ids)})")


@dataclass(frozen=True)
class Fts5RepairResult:
    """Content-free outcome of the staged FTS5 offline repair path."""

    outcome: str
    applied: bool
    tables: tuple[str, ...]
    preflight: IntegrityReport
    postflight: IntegrityReport | None = None
    backup_name: str | None = None
    backup_evidence: BackupEvidence | None = None

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
            "backup_name_is_advisory": self.backup_name is not None,
            "backup_evidence": (
                self.backup_evidence.to_dict() if self.backup_evidence is not None else None
            ),
            "preflight": self.preflight.to_dict(),
            "postflight": self.postflight.to_dict() if self.postflight else None,
            "content_included": False,
            "cleanup_automatic": False,
        }


def _rebuild_fts5_tables(
    database: Path,
    tables: tuple[str, ...],
    budget: RecoveryBudget,
) -> None:
    budget.checkpoint()
    with sqlite3.connect(database, isolation_level=None) as connection:
        with sqlite_budget_guard(connection, budget):
            connection.execute("BEGIN IMMEDIATE")
            try:
                for table in tables:
                    budget.checkpoint()
                    identifier = _quote_identifier(table)
                    statement = f"INSERT INTO {identifier} ({identifier}) VALUES (?)"
                    connection.execute(statement, ("rebuild",))
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise


def _repair_fts5_authorized(
    source: RecoverySource,
    source_snapshot: SourceSnapshot,
    *,
    apply: bool,
) -> Fts5RepairResult:
    preflight = probe_authorized_database(source, source_snapshot)
    tables = preflight.corrupt_fts5_tables
    if not preflight.repair_safe:
        return Fts5RepairResult("blocked-unclassified-corruption", False, tables, preflight)
    if not tables:
        return Fts5RepairResult("clean", False, (), preflight)
    if not apply:
        assert_source_unchanged(source, source_snapshot)
        return Fts5RepairResult("dry-run", False, tables, preflight)

    revalidate_source_binding(source, source_snapshot)
    attempt = allocate_recovery_attempt(
        source,
        "fts5-repair",
        source_snapshot,
        recovery_attempt_binding(source, source_snapshot),
    )
    try:
        copy_preserved_entries(
            source,
            attempt,
            source_snapshot,
            excluded_names=frozenset(),
        )
        with hold_private_regular_file(
            attempt.staging_handle,
            "chroma.sqlite3",
        ) as database_descriptor:
            _rebuild_fts5_tables(
                Path("/proc/self/fd") / str(database_descriptor),
                tables,
                source.budget,
            )
        account_staging_tree(attempt.staging_handle)
        staged_report = probe_database_directory(attempt.staging_handle)
        if not staged_report.ok:
            return Fts5RepairResult(
                "verification-failed",
                False,
                tables,
                preflight,
                staged_report,
                str(attempt.root),
            )
        revalidate_source_binding(source, source_snapshot)
        postflight: list[IntegrityReport] = []

        def verify_swapped(swapped: HeldDirectory) -> VerificationResult:
            report = probe_database_directory(swapped)
            postflight.append(report)
            return VerificationResult(report.ok, "FTS5/SQLite integrity verified")

        swap_result = swap_staged_palace(
            source,
            attempt,
            source_snapshot,
            verify_swapped,
        )
    except RecoveryRefusal:
        raise
    except (OSError, RuntimeError, ValidationError, RecoverySwapError):
        return Fts5RepairResult(
            "repair-failed",
            False,
            tables,
            preflight,
            backup_name=str(attempt.root),
        )
    finally:
        attempt.close()
    return Fts5RepairResult(
        "repaired",
        True,
        tables,
        preflight,
        postflight[-1] if postflight else None,
        str(swap_result.backup.advisory_path),
        swap_result.backup,
    )


def repair_fts5_indexes(
    offline_target: Path,
    receipt: Path,
    *,
    apply: bool = False,
) -> Fts5RepairResult:
    """Inspect or repair classified FTS5 corruption in a receipt-authorized copy."""

    with open_authorized_recovery(offline_target, receipt) as source:
        snapshot = snapshot_source_tree(source)
        return _repair_fts5_authorized(source, snapshot, apply=apply)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--offline-target", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument(
        "--apply", action="store_true", help="allocate, verify, and swap one preserved attempt"
    )
    parser.add_argument(
        "--fts5-only",
        action="store_true",
        help="inspect or rebuild only classified corrupt FTS5 indexes",
    )
    parser.add_argument(
        "--allow-reembedding",
        action="store_true",
        help="separately authorize full repair to generate new embeddings (not exact-vector recovery)",
    )
    return parser


def _apply_full_repair(
    source: RecoverySource,
    source_snapshot: SourceSnapshot,
    ids: list[str],
    documents: list[str],
    metadatas: list[dict[str, MetadataValue] | None],
) -> int:
    revalidate_source_binding(source, source_snapshot)
    attempt = allocate_recovery_attempt(
        source,
        "reembedding-repair",
        source_snapshot,
        recovery_attempt_binding(source, source_snapshot),
    )
    try:
        copy_preserved_entries(
            source,
            attempt,
            source_snapshot,
            excluded_names=_chroma_entry_names(source_snapshot),
        )
        print(f"[repair] re-embedding into preserved attempt {attempt.root}")
        _build(attempt.staging_handle, COLLECTION, ids, documents, metadatas)
        account_staging_tree(attempt.staging_handle)
        staged_verification = _verify_full_rebuild(
            attempt.staging_handle,
            ids,
            documents,
            metadatas,
        )
        if not staged_verification.ok:
            print(
                f"[repair] ABORT: {staged_verification.detail}; "
                f"attempt preserved at {attempt.root}"
            )
            return 1
        revalidate_source_binding(source, source_snapshot)
        swap_result = swap_staged_palace(
            source,
            attempt,
            source_snapshot,
            lambda swapped: _verify_full_rebuild(swapped, ids, documents, metadatas),
        )
    except RecoveryRefusal:
        raise
    except RecoverySwapError as exc:
        print(f"[repair] ABORT: {exc}; attempt preserved at {attempt.root}")
        return 1
    except (OSError, RuntimeError, ValidationError) as exc:
        print(
            f"[repair] ABORT: {type(exc).__name__}; " f"source/attempt preserved at {attempt.root}"
        )
        return 1
    finally:
        attempt.close()

    backup = swap_result.backup
    print(
        "[repair] swapped and verified. Previous source backup advisory path: "
        f"{backup.advisory_path}"
    )
    print(
        "[repair] exact backup identity evidence: " + json.dumps(backup.to_dict(), sort_keys=True)
    )
    print("[repair] cleanup is separate and is never performed automatically.")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    with open_authorized_recovery(args.offline_target, args.receipt) as source:
        palace = source.target
        source_snapshot = snapshot_source_tree(source)
        has_database = any(
            member.relative_path == "chroma.sqlite3" and member.kind == "file"
            for member in source_snapshot.members
        )
        if not has_database:
            print(f"[repair] no regular chroma.sqlite3 at {palace} — nothing to repair.")
            return 2

        if args.fts5_only:
            fts5_result = _repair_fts5_authorized(
                source,
                source_snapshot,
                apply=args.apply,
            )
            print(json.dumps(fts5_result.to_dict(), indent=2))
            return 0 if fts5_result.passed else 1

        integrity = probe_authorized_database(source, source_snapshot)
        if not integrity.repair_safe:
            print("[repair] blocked: temporary-copy integrity found unclassified corruption.")
            print(json.dumps(integrity.to_dict(), indent=2))
            return 1
        if integrity.corrupt_fts5_tables:
            print("[repair] classified FTS5 corruption detected; use --fts5-only first.")

        with materialize_sqlite_family(
            source.root,
            expected_snapshot=source_snapshot,
            account_as_input=True,
        ) as copied_database:
            ids, documents, metadatas = _extract_records(copied_database, source.budget)
        assert_source_unchanged(source, source_snapshot)
        print(f"[repair] palace={palace} collection={COLLECTION}")
        print(f"[repair] SQLite inspection found {len(ids)} drawer records")
        print("[repair] preview: no Chroma/build/staging/rename/swap/cleanup was performed")
        if not ids:
            print("[repair] no records extracted — refusing an empty replacement.")
            return 1
        if not args.apply:
            print("[repair] PREVIEW only. Exact-vector recoverability was not established.")
            return 0
        if not args.allow_reembedding:
            print(
                "[repair] ABORT: --apply alone does not authorize re-embedding. Add "
                "--allow-reembedding, or use rebuild_from_disk for exact-vector recovery."
            )
            return 1
        return _apply_full_repair(source, source_snapshot, ids, documents, metadatas)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"[repair] ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
