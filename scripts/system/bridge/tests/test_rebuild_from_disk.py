"""Regression tests for exact-vector offline recovery semantics."""

from __future__ import annotations

import os
import sqlite3
import struct
import subprocess
from pathlib import Path

import pytest

from scripts.system.bridge.recovery_safety import (
    FileIdentity,
    HeldDirectory,
    RecoveryBudget,
)
from scripts.system.bridge.rebuild_from_disk import (
    RecoveryRecord,
    SafeRecoveryInspection,
    collect_exact_recovery_input,
    read_pending,
    verify,
)
from scripts.system.memory.common import ValidationError


def _queue(tmp_path: Path, rows: list[tuple[object, ...]]) -> Path:
    palace = tmp_path / "palace"
    palace.mkdir()
    connection = sqlite3.connect(palace / "chroma.sqlite3")
    connection.execute(
        "CREATE TABLE embeddings_queue ("
        "seq_id INTEGER PRIMARY KEY, operation INTEGER, id TEXT, vector BLOB)"
    )
    connection.executemany("INSERT INTO embeddings_queue VALUES (?, ?, ?, ?)", rows)
    connection.commit()
    connection.close()
    return palace


def _vec(*values: float) -> bytes:
    return struct.pack("<" + "f" * len(values), *values)


def test_chromadb_operation_codes_are_not_confused(tmp_path: Path) -> None:
    """0 ADD, 1 UPDATE, 2 UPSERT, 3 DELETE — especially 1 is not delete."""

    palace = _queue(
        tmp_path,
        [
            (1, 0, "added", _vec(1.0, 2.0)),
            (2, 1, "metadata-only-update", None),
            (3, 1, "vector-update", _vec(3.0, 4.0)),
            (4, 2, "upserted", _vec(5.0, 6.0)),
            (5, 3, "deleted", None),
        ],
    )
    vectors, deleted = read_pending(palace / "chroma.sqlite3")

    assert set(vectors) == {"added", "vector-update", "upserted"}
    assert vectors["vector-update"] == (3.0, 4.0)
    assert deleted == {"deleted"}
    assert "metadata-only-update" not in deleted


def test_later_operation_wins_for_same_id(tmp_path: Path) -> None:
    palace = _queue(
        tmp_path,
        [
            (1, 0, "x", _vec(1.0)),
            (2, 3, "x", None),
            (3, 2, "x", _vec(2.0)),
            (4, 1, "x", None),
        ],
    )
    vectors, deleted = read_pending(palace / "chroma.sqlite3")

    assert vectors == {"x": (2.0,)}
    assert deleted == set()


def test_pending_upsert_and_delete_take_precedence_over_index_vectors() -> None:
    inspection = SafeRecoveryInspection(
        documents={"updated": "doc-u", "deleted": "doc-d"},
        metadata={"updated": {"wing": "test"}, "deleted": {"wing": "test"}},
        pending_vectors={"updated": (9.0, 10.0)},
        pending_deletes=frozenset({"deleted"}),
    )

    recovery = collect_exact_recovery_input(
        inspection,
        {"updated": (1.0, 2.0), "deleted": (3.0, 4.0)},
    )

    assert [record.record_id for record in recovery.records] == ["updated"]
    assert recovery.records[0].embedding == (9.0, 10.0)
    assert recovery.missing == ()
    assert recovery.pending_delete_count == 1
    assert recovery.vector_dimensions == 2


def test_missing_vector_is_retained_as_a_blocking_identity() -> None:
    inspection = SafeRecoveryInspection(
        documents={"kept": "doc", "missing": "doc"},
        metadata={},
        pending_vectors={},
        pending_deletes=frozenset(),
    )

    recovery = collect_exact_recovery_input(inspection, {"kept": (1.0,)})

    assert [record.record_id for record in recovery.records] == ["kept"]
    assert recovery.missing == ("missing",)


def test_pending_vector_without_metadata_is_rejected() -> None:
    inspection = SafeRecoveryInspection(
        documents={},
        metadata={},
        pending_vectors={"orphan": (1.0,)},
        pending_deletes=frozenset(),
    )

    with pytest.raises(ValidationError, match="IDs absent"):
        collect_exact_recovery_input(inspection, {})


def test_verification_child_receives_no_inherited_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_environment: dict[str, str] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        environment = kwargs.get("env")
        assert isinstance(environment, dict)
        captured_environment.update(environment)
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=b'{"ok": true, "detail": "synthetic"}\n',
            stderr=b"",
        )

    monkeypatch.setenv("SYNTHETIC_SECRET", "must-not-cross")
    monkeypatch.setattr("scripts.system.bridge.rebuild_from_disk.subprocess.run", fake_run)
    stage = tmp_path / "stage"
    stage.mkdir()
    descriptor = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = os.fstat(descriptor)
    held = HeldDirectory(
        descriptor,
        FileIdentity.from_stat(opened),
        stage,
        RecoveryBudget(),
        "test-stage",
    )
    try:
        result = verify(
            held,
            [RecoveryRecord("id", "doc", {"wing": "test"}, (1.0, 2.0))],
        )
    finally:
        os.close(descriptor)

    assert result.ok is True
    assert captured_environment == {
        "ANONYMIZED_TELEMETRY": "False",
        "HOME": "/proc/self/fd",
        "PYTHONHASHSEED": "0",
    }
    assert "SYNTHETIC_SECRET" not in captured_environment


def test_traversal_shaped_record_id_remains_data_not_a_path(tmp_path: Path) -> None:
    victim = tmp_path / "victim"
    victim.write_text("unchanged", encoding="utf-8")
    record_id = "../../victim"
    inspection = SafeRecoveryInspection(
        documents={record_id: "doc"},
        metadata={record_id: {"path-like": "../../../outside"}},
        pending_vectors={record_id: (1.0, 2.0)},
        pending_deletes=frozenset(),
    )

    recovery = collect_exact_recovery_input(inspection, {})

    assert recovery.records[0].record_id == record_id
    assert recovery.records[0].metadata == {"path-like": "../../../outside"}
    assert victim.read_text(encoding="utf-8") == "unchanged"
