from __future__ import annotations

from pathlib import Path

import pytest

from checks.check_no_raw_memory_peer import ROOT, scan
from maintenance import (
    mempalace_cleanup,
    one_time_cleanup_2026_07,
    rebuild_collection_index,
)


def test_repository_memory_callers_pass_raw_peer_guard() -> None:
    assert scan(ROOT) == []


def test_guard_rejects_production_raw_import(tmp_path: Path) -> None:
    caller = tmp_path / "scripts" / "system" / "evals" / "bad.py"
    caller.parent.mkdir(parents=True)
    caller.write_text("import chromadb\nchromadb.PersistentClient(path='x')\n", encoding="utf-8")

    violations = scan(tmp_path)

    assert {violation.reason for violation in violations} == {
        "raw peer import: chromadb",
        "direct Chroma PersistentClient",
    }


@pytest.mark.parametrize(
    "module",
    [mempalace_cleanup, one_time_cleanup_2026_07, rebuild_collection_index],
)
def test_obsolete_raw_normal_paths_are_quarantined(module: object) -> None:
    assert getattr(module, "main")(["--apply"]) == 2


def test_guard_rejects_legacy_bridge_spawn(tmp_path: Path) -> None:
    caller = tmp_path / "scripts" / "system" / "maintenance" / "bad.py"
    caller.parent.mkdir(parents=True)
    caller.write_text("subprocess.run(['python', 'memory_bridge.py'])\n", encoding="utf-8")

    violations = scan(tmp_path)

    assert [violation.reason for violation in violations] == [
        "raw peer spawn/reference: memory_bridge.py"
    ]


def test_named_offline_module_requires_runtime_receipt_gate(tmp_path: Path) -> None:
    recovery = tmp_path / "scripts" / "system" / "bridge" / "palace_doctor.py"
    recovery.parent.mkdir(parents=True)
    recovery.write_text("import sqlite3\nsqlite3.connect('chroma.sqlite3')\n", encoding="utf-8")

    violations = scan(tmp_path)

    assert [violation.reason for violation in violations] == [
        "offline module lacks runtime receipt gate"
    ]


def test_candidate_preflight_must_remain_synthetic_only(tmp_path: Path) -> None:
    preflight = tmp_path / "scripts" / "system" / "memory" / "candidate_preflight.py"
    preflight.parent.mkdir(parents=True)
    preflight.write_text(
        "import sqlite3\nsqlite3.connect('chroma.sqlite3')\n# --offline-target\n",
        encoding="utf-8",
    )

    violations = scan(tmp_path)

    assert [violation.reason for violation in violations] == [
        "synthetic raw module must create only temporary data and accept no offline target"
    ]
