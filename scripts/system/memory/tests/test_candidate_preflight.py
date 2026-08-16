from __future__ import annotations

import importlib.metadata
import json
import sqlite3
import stat
from pathlib import Path

import pytest

from memory import candidate_preflight


def test_candidate_preflight_proves_detection_repair_and_broad_corruption_gate() -> None:
    mempalace_version = importlib.metadata.version("mempalace")
    chromadb_version = importlib.metadata.version("chromadb")
    selected_environment = sqlite3.sqlite_version == "3.37.2"

    report = candidate_preflight.run_preflight(
        expected_sqlite=sqlite3.sqlite_version,
        expected_mempalace=mempalace_version,
        expected_chromadb=chromadb_version,
        require_fixture_precondition_absent=selected_environment,
    )

    assert report["passed"] is True
    assert report["checks"]["environment_matches"] is True
    assert report["checks"]["clean_probe"] is True
    assert report["checks"]["independent_fts5_detection"] is True
    assert report["checks"]["selected_environment_fts5_repair"] is True
    assert report["checks"]["non_fts_corruption_blocks_repair"] is True
    assert report["evidence"]["zeroblob_source_bytes_unchanged"] is True
    assert report["evidence"]["repair_content_row_count_preserved"] is True
    assert report["content_included"] is False
    if selected_environment:
        assert report["checks"]["upstream_fixture_precondition_absent"] is True
        assert report["evidence"]["zeroblob_quick_check_ok"] is True


def test_candidate_preflight_cli_writes_new_owner_only_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "candidate-report.json"
    synthetic_report = {
        "schema_version": 1,
        "report_type": "memory-candidate-compatibility-preflight",
        "passed": True,
        "content_included": False,
    }
    monkeypatch.setattr(candidate_preflight, "run_preflight", lambda **_kwargs: synthetic_report)

    result = candidate_preflight.main(
        [
            "--expected-sqlite",
            sqlite3.sqlite_version,
            "--expected-mempalace",
            "test",
            "--expected-chromadb",
            "test",
            "--output",
            str(output),
        ]
    )

    assert result == 0
    assert json.loads(output.read_text(encoding="utf-8")) == synthetic_report
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert (
        candidate_preflight.main(
            [
                "--expected-sqlite",
                sqlite3.sqlite_version,
                "--expected-mempalace",
                "test",
                "--expected-chromadb",
                "test",
                "--output",
                str(output),
            ]
        )
        == 2
    )
