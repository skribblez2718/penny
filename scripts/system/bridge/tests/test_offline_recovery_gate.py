"""Recovery CLIs must fail before byte access without an explicit offline gate."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from scripts.system.bridge import rebuild_from_disk, repair_palace
from scripts.system.bridge.fts5_integrity import (
    FindingClass,
    FindingCode,
    IntegrityFinding,
    IntegrityReport,
)
from scripts.system.memory.common import ValidationError


def test_repair_rejects_relative_target_before_sqlite_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        repair_palace,
        "_extract_records",
        lambda _path: pytest.fail("repair read bytes before offline authorization"),
    )

    with pytest.raises(ValidationError, match="explicit absolute"):
        repair_palace.main(["--offline-target", "relative", "--receipt", "relative"])


def test_rebuild_rejects_relative_target_before_sqlite_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rebuild_from_disk,
        "read_sqlite",
        lambda _path: pytest.fail("rebuild read bytes before offline authorization"),
    )

    with pytest.raises(ValidationError, match="explicit absolute"):
        rebuild_from_disk.main(["--offline-target", "relative", "--receipt", "relative"])


def _offline_fixture(tmp_path: Path) -> tuple[Path, Path]:
    target = tmp_path / "copied-palace"
    target.mkdir(mode=0o700)
    sqlite3.connect(target / "chroma.sqlite3").close()
    receipt = tmp_path / "receipt.json"
    receipt.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "receipt_type": "memory-offline-access",
                "target_kind": "copied-offline",
                "target_path": str(target),
                "source_id": "synthetic-unclassified-gate",
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
    return target, receipt


def _unclassified_report() -> IntegrityReport:
    finding = IntegrityFinding(
        FindingCode.SQLITE_CORRUPTION_UNCLASSIFIED,
        FindingClass.UNCLASSIFIED,
    )
    return IntegrityReport("test", (), (finding,), True)


def test_full_repair_blocks_unclassified_corruption_before_extract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _offline_fixture(tmp_path)
    monkeypatch.setattr(
        repair_palace, "probe_authorized_database", lambda _auth: _unclassified_report()
    )
    monkeypatch.setattr(
        repair_palace,
        "_extract_records",
        lambda _path: pytest.fail("repair extracted rows after unclassified corruption"),
    )

    assert repair_palace.main(["--offline-target", str(target), "--receipt", str(receipt)]) == 1


def test_disk_rebuild_blocks_unclassified_corruption_before_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _offline_fixture(tmp_path)
    monkeypatch.setattr(
        rebuild_from_disk, "probe_authorized_database", lambda _auth: _unclassified_report()
    )
    monkeypatch.setattr(
        rebuild_from_disk,
        "read_sqlite",
        lambda _path: pytest.fail("disk rebuild read rows after unclassified corruption"),
    )

    assert rebuild_from_disk.main(["--offline-target", str(target), "--receipt", str(receipt)]) == 1


def test_recovery_modules_have_no_configured_path_default() -> None:
    repair_source = Path(repair_palace.__file__).read_text(encoding="utf-8")
    rebuild_source = Path(rebuild_from_disk.__file__).read_text(encoding="utf-8")

    assert "--offline-target" in repair_source
    assert "--offline-target" in rebuild_source
    assert "MEMPALACE_PATH" not in repair_source
    assert "MEMPALACE_PATH" not in rebuild_source
