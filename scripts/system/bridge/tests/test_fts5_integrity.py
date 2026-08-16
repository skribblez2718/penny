"""Regression coverage for receipt-gated temporary-copy FTS5 inspection."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from scripts.system.bridge import fts5_integrity, repair_palace

SELECTED_SQLITE_VERSION = "3.37.2"
UPSTREAM_ROW_COUNT = 200


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _receipt(tmp_path: Path, palace: Path, name: str) -> Path:
    receipt = tmp_path / f"{name}-receipt.json"
    receipt.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "receipt_type": "memory-offline-access",
                "target_kind": "copied-offline",
                "target_path": str(palace),
                "source_id": name,
                "authority_timestamp": "2026-08-16T12:00:00Z",
                "approved_by": "pytest",
                "checks": {
                    "drain_complete": True,
                    "hub_stopped": True,
                    "peer_processes_stopped": True,
                    "target_is_copy": True,
                },
            }
        ),
        encoding="utf-8",
    )
    receipt.chmod(0o600)
    return receipt


def _fts5_palace(tmp_path: Path, name: str, *, corrupt: bool) -> tuple[Path, Path]:
    palace = tmp_path / name
    palace.mkdir(mode=0o700)
    database = palace / "chroma.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE VIRTUAL TABLE embedding_fulltext_search "
            "USING fts5(string_value, tokenize='unicode61')"
        )
        connection.executemany(
            "INSERT INTO embedding_fulltext_search(string_value) VALUES (?)",
            [
                (f"alpha beta gamma row{index} delta epsilon",)
                for index in range(UPSTREAM_ROW_COUNT)
            ],
        )
        connection.commit()
        if corrupt:
            # Exact MemPalace 3.7.1 upstream fixture mutation.
            connection.execute(
                "UPDATE embedding_fulltext_search_data "
                "SET block = zeroblob(length(block)) "
                "WHERE id = (SELECT max(id) FROM embedding_fulltext_search_data)"
            )
            connection.commit()
    return palace, _receipt(tmp_path, palace, name)


def _non_fts_corrupt_palace(tmp_path: Path) -> tuple[Path, Path]:
    palace = tmp_path / "broad-corruption"
    palace.mkdir(mode=0o700)
    database = palace / "chroma.sqlite3"
    with sqlite3.connect(database) as connection:
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        connection.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        connection.executemany(
            "INSERT INTO records(value) VALUES (?)",
            [("x" * 200,) for _ in range(UPSTREAM_ROW_COUNT)],
        )
        connection.commit()
        root_page = int(
            connection.execute(
                "SELECT rootpage FROM sqlite_master WHERE type = ? AND name = ?",
                ("table", "records"),
            ).fetchone()[0]
        )
    with database.open("r+b") as handle:
        handle.seek((root_page - 1) * page_size)
        handle.write(b"\x00")
    return palace, _receipt(tmp_path, palace, "broad-corruption")


def test_upstream_zeroblob_is_detected_on_temp_copy_without_source_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    palace, receipt = _fts5_palace(tmp_path, "zeroblob", corrupt=True)
    database = palace / "chroma.sqlite3"
    before = _hash(database)
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        quick_check = connection.execute("PRAGMA quick_check").fetchall()

    opened: list[Path] = []
    real_connect = sqlite3.connect

    def spy(database_arg: object, *args: object, **kwargs: object) -> sqlite3.Connection:
        if isinstance(database_arg, (str, Path)) and str(database_arg) != ":memory:":
            opened.append(Path(database_arg))
        return real_connect(database_arg, *args, **kwargs)

    monkeypatch.setattr(fts5_integrity.sqlite3, "connect", spy)
    report = fts5_integrity.probe_offline_database(palace, receipt)

    if sqlite3.sqlite_version == SELECTED_SQLITE_VERSION:
        assert quick_check == [("ok",)]
    assert report.ok is False
    assert report.repair_safe is True
    assert report.corrupt_fts5_tables == ("embedding_fulltext_search",)
    assert [finding.code for finding in report.findings] == [
        fts5_integrity.FindingCode.FTS5_INDEX_CORRUPT
    ]
    assert report.findings[0].sqlite_error_name == "SQLITE_CORRUPT_VTAB"
    assert report.source_bytes_unchanged is True
    assert _hash(database) == before
    assert opened
    assert all(path.resolve() != database.resolve() for path in opened)
    assert "alpha beta gamma" not in json.dumps(report.to_dict())


def test_clean_fts5_and_non_fts_tables_pass(tmp_path: Path) -> None:
    palace, receipt = _fts5_palace(tmp_path, "clean", corrupt=False)
    with sqlite3.connect(palace / "chroma.sqlite3") as connection:
        connection.execute("CREATE TABLE ordinary (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO ordinary(value) VALUES (?)", ("not reported",))
        connection.commit()

    report = fts5_integrity.probe_offline_database(palace, receipt)

    assert report.ok is True
    assert report.repair_safe is True
    assert report.fts5_tables == ("embedding_fulltext_search",)
    assert report.findings == ()
    assert report.to_dict()["content_included"] is False


def test_non_fts_corruption_is_unclassified_and_blocks_repair(tmp_path: Path) -> None:
    palace, receipt = _non_fts_corrupt_palace(tmp_path)
    database = palace / "chroma.sqlite3"
    before = _hash(database)

    report = fts5_integrity.probe_offline_database(palace, receipt)
    repair = repair_palace.repair_fts5_indexes(palace, receipt, apply=True)

    assert report.ok is False
    assert report.repair_safe is False
    assert all(
        finding.classification is fts5_integrity.FindingClass.UNCLASSIFIED
        for finding in report.findings
    )
    assert repair.outcome == "blocked-unclassified-corruption"
    assert repair.applied is False
    assert repair.passed is False
    assert _hash(database) == before


def test_schema_derived_identifier_is_quoted_and_unusual_fts5_name_is_safe(
    tmp_path: Path,
) -> None:
    palace = tmp_path / "quoted-name"
    palace.mkdir(mode=0o700)
    database = palace / "chroma.sqlite3"
    table = 'fts"; DROP TABLE sentinel; --'
    identifier = fts5_integrity._quote_identifier(table)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE sentinel (id INTEGER PRIMARY KEY)")
        connection.execute(f"CREATE VIRTUAL TABLE {identifier} USING fts5(value)")
        connection.execute(f"INSERT INTO {identifier}(value) VALUES (?)", ("safe",))
        connection.commit()
    receipt = _receipt(tmp_path, palace, "quoted-name")

    report = fts5_integrity.probe_offline_database(palace, receipt)

    assert report.ok is True
    assert report.fts5_tables == (table,)
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM sqlite_master WHERE type = ? AND name = ?",
            ("table", "sentinel"),
        ).fetchone() == (1,)


def test_fts5_only_repair_is_dry_run_by_default_and_verified_on_apply(tmp_path: Path) -> None:
    palace, receipt = _fts5_palace(tmp_path, "repairable", corrupt=True)
    database = palace / "chroma.sqlite3"
    before = _hash(database)

    dry_run = repair_palace.repair_fts5_indexes(palace, receipt)
    assert dry_run.outcome == "dry-run"
    assert dry_run.applied is False
    assert _hash(database) == before

    applied = repair_palace.repair_fts5_indexes(palace, receipt, apply=True)

    assert applied.outcome == "repaired"
    assert applied.passed is True
    assert applied.applied is True
    assert applied.postflight is not None and applied.postflight.ok
    assert applied.backup_name is not None
    assert (palace / applied.backup_name).is_file()
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM embedding_fulltext_search "
            "WHERE embedding_fulltext_search MATCH ?",
            ("gamma",),
        ).fetchone() == (UPSTREAM_ROW_COUNT,)
