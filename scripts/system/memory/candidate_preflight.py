"""Generate content-free candidate compatibility and FTS5 repair evidence.

The command creates only synthetic SQLite databases under a temporary
directory.  It verifies the selected interpreter/package versions, reproduces
the upstream FTS5 zeroblob fixture, exercises Penny's receipt-gated temporary-
copy probe and FTS5-only repair, and proves broad corruption blocks repair.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

from scripts.system.bridge.fts5_integrity import probe_offline_database
from scripts.system.bridge.repair_palace import repair_fts5_indexes
from scripts.system.memory.common import (
    ValidationError,
    atomic_write_json,
    require_absolute_path,
    utc_now,
)

PREFLIGHT_SCHEMA_VERSION = 1
PREFLIGHT_REPORT_TYPE = "memory-candidate-compatibility-preflight"
SYNTHETIC_ROW_COUNT = 200


def _package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def _write_receipt(root: Path, target: Path, source_id: str) -> Path:
    receipt = root / f"{source_id}-offline-receipt.json"
    atomic_write_json(
        receipt,
        {
            "schema_version": 1,
            "receipt_type": "memory-offline-access",
            "target_kind": "copied-offline",
            "target_path": str(target),
            "source_id": source_id,
            "authority_timestamp": utc_now(),
            "approved_by": "candidate-preflight",
            "checks": {
                "drain_complete": True,
                "hub_stopped": True,
                "peer_processes_stopped": True,
                "target_is_copy": True,
            },
        },
    )
    return receipt


def _fts5_fixture(root: Path, name: str, *, corrupt: bool) -> tuple[Path, Path]:
    palace = root / name
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
                for index in range(SYNTHETIC_ROW_COUNT)
            ],
        )
        connection.commit()
        if corrupt:
            connection.execute(
                "UPDATE embedding_fulltext_search_data "
                "SET block = zeroblob(length(block)) "
                "WHERE id = (SELECT max(id) FROM embedding_fulltext_search_data)"
            )
            connection.commit()
    return palace, _write_receipt(root, palace, name)


def _quick_check_ok(database: Path) -> bool:
    with sqlite3.connect(database) as connection:
        return connection.execute("PRAGMA quick_check").fetchall() == [("ok",)]


def _content_row_count(database: Path) -> int:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT count(*) FROM embedding_fulltext_search_content"
        ).fetchone()
    return int(row[0]) if row else -1


def _non_fts_corrupt_fixture(root: Path) -> tuple[Path, Path]:
    palace = root / "non-fts-corruption"
    palace.mkdir(mode=0o700)
    database = palace / "chroma.sqlite3"
    with sqlite3.connect(database) as connection:
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        connection.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        connection.executemany(
            "INSERT INTO records(value) VALUES (?)",
            [(f"synthetic-{index:05d}-" + "x" * 200,) for index in range(SYNTHETIC_ROW_COUNT)],
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
        handle.flush()
    return palace, _write_receipt(root, palace, "non-fts-corruption")


def _environment(expected: dict[str, str]) -> tuple[dict[str, Any], bool]:
    with sqlite3.connect(":memory:") as connection:
        fts5_enabled = bool(
            connection.execute("SELECT sqlite_compileoption_used('ENABLE_FTS5')").fetchone()[0]
        )
    actual = {
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
        "mempalace": _package_version("mempalace"),
        "chromadb": _package_version("chromadb"),
        "fts5_enabled": fts5_enabled,
    }
    matches = (
        actual["sqlite"] == expected["sqlite"]
        and actual["mempalace"] == expected["mempalace"]
        and actual["chromadb"] == expected["chromadb"]
        and actual["fts5_enabled"] is True
    )
    return actual, matches


def run_preflight(
    *,
    expected_sqlite: str,
    expected_mempalace: str,
    expected_chromadb: str,
    require_fixture_precondition_absent: bool,
) -> dict[str, Any]:
    """Run synthetic compatibility checks and return a content-free report."""

    expected = {
        "sqlite": expected_sqlite,
        "mempalace": expected_mempalace,
        "chromadb": expected_chromadb,
    }
    actual, environment_matches = _environment(expected)

    with tempfile.TemporaryDirectory(prefix="penny-candidate-preflight-") as temporary:
        root = Path(temporary)

        clean_palace, clean_receipt = _fts5_fixture(root, "clean", corrupt=False)
        clean = probe_offline_database(clean_palace, clean_receipt)

        fixture_palace, fixture_receipt = _fts5_fixture(root, "zeroblob-detection", corrupt=True)
        quick_check_ok = _quick_check_ok(fixture_palace / "chroma.sqlite3")
        detected = probe_offline_database(fixture_palace, fixture_receipt)
        fixture_precondition_absent = quick_check_ok
        independent_detection_passed = (
            detected.repair_safe
            and detected.corrupt_fts5_tables == ("embedding_fulltext_search",)
            and detected.source_bytes_unchanged
        )

        repair_palace, repair_receipt = _fts5_fixture(root, "zeroblob-repair", corrupt=True)
        before_rows = _content_row_count(repair_palace / "chroma.sqlite3")
        repair = repair_fts5_indexes(repair_palace, repair_receipt, apply=True)
        after_rows = _content_row_count(repair_palace / "chroma.sqlite3")
        repair_passed = (
            repair.passed
            and repair.outcome == "repaired"
            and repair.postflight is not None
            and repair.postflight.ok
            and before_rows == SYNTHETIC_ROW_COUNT
            and after_rows == before_rows
        )

        broad_palace, broad_receipt = _non_fts_corrupt_fixture(root)
        broad = probe_offline_database(broad_palace, broad_receipt)
        broad_corruption_blocked = not broad.repair_safe and any(
            finding.classification.value == "unclassified-corruption" for finding in broad.findings
        )

    waiver_condition_met = (
        fixture_precondition_absent if require_fixture_precondition_absent else True
    )
    checks = {
        "environment_matches": environment_matches,
        "clean_probe": clean.ok and clean.source_bytes_unchanged,
        "upstream_fixture_precondition_absent": fixture_precondition_absent,
        "independent_fts5_detection": independent_detection_passed,
        "selected_environment_fts5_repair": repair_passed,
        "non_fts_corruption_blocks_repair": broad_corruption_blocked,
    }
    passed = all(
        (
            environment_matches,
            checks["clean_probe"],
            waiver_condition_met,
            independent_detection_passed,
            repair_passed,
            broad_corruption_blocked,
        )
    )
    return {
        "schema_version": PREFLIGHT_SCHEMA_VERSION,
        "report_type": PREFLIGHT_REPORT_TYPE,
        "generated_at": utc_now(),
        "passed": passed,
        "confidence": "CERTAIN",
        "expected_environment": expected,
        "actual_environment": actual,
        "waiver_precondition_required_absent": require_fixture_precondition_absent,
        "waiver_precondition_met": waiver_condition_met,
        "checks": checks,
        "evidence": {
            "clean_findings": [finding.to_dict() for finding in clean.findings],
            "zeroblob_quick_check_ok": quick_check_ok,
            "zeroblob_findings": [finding.to_dict() for finding in detected.findings],
            "zeroblob_source_bytes_unchanged": detected.source_bytes_unchanged,
            "repair_outcome": repair.outcome,
            "repair_postflight_findings": (
                [finding.to_dict() for finding in repair.postflight.findings]
                if repair.postflight
                else None
            ),
            "repair_content_row_count_preserved": after_rows == before_rows,
            "non_fts_findings": [finding.to_dict() for finding in broad.findings],
            "non_fts_repair_safe": broad.repair_safe,
        },
        "content_included": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--expected-sqlite", required=True)
    parser.add_argument("--expected-mempalace", required=True)
    parser.add_argument("--expected-chromadb", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--require-fixture-precondition-absent",
        action="store_true",
        help="fail unless the upstream quick_check corruption precondition is absent",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        output = require_absolute_path(str(args.output), "output", must_exist=False)
        report = run_preflight(
            expected_sqlite=args.expected_sqlite,
            expected_mempalace=args.expected_mempalace,
            expected_chromadb=args.expected_chromadb,
            require_fixture_precondition_absent=args.require_fixture_precondition_absent,
        )
        atomic_write_json(output, report)
    except (OSError, sqlite3.Error, ValidationError) as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": "candidate-preflight-failed",
                    "error_type": type(error).__name__,
                    "content_included": False,
                }
            )
        )
        return 2
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
