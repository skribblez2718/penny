"""Recovery CLIs must fail before byte access without an explicit offline gate."""

from __future__ import annotations

import json
import pickle
import sqlite3
import struct
from pathlib import Path

import pytest

from scripts.system.bridge import rebuild_from_disk, repair_palace
from scripts.system.bridge.recovery_safety import (
    VerificationResult,
    open_authorized_recovery,
    snapshot_source_tree,
)
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
        repair_palace,
        "probe_authorized_database",
        lambda _source, _snapshot: _unclassified_report(),
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
        rebuild_from_disk,
        "probe_authorized_database",
        lambda _source, _snapshot: _unclassified_report(),
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


def _exact_sqlite_fixture(tmp_path: Path) -> tuple[Path, Path]:
    target, receipt = _offline_fixture(tmp_path)
    with sqlite3.connect(target / "chroma.sqlite3") as connection:
        connection.executescript("""
            CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE segments (id TEXT PRIMARY KEY, collection TEXT, scope TEXT);
            CREATE TABLE embeddings (
                id INTEGER PRIMARY KEY, embedding_id TEXT, segment_id TEXT
            );
            CREATE TABLE embedding_metadata (
                id INTEGER, key TEXT, string_value TEXT, int_value INTEGER,
                float_value REAL, bool_value INTEGER
            );
            CREATE TABLE embeddings_queue (
                seq_id INTEGER PRIMARY KEY, operation INTEGER, id TEXT, vector BLOB
            );
            """)
        connection.execute(
            "INSERT INTO collections(id, name) VALUES (?, ?)", ("collection", "mempalace_drawers")
        )
        connection.execute(
            "INSERT INTO segments(id, collection, scope) VALUES (?, ?, ?)",
            ("metadata-segment", "collection", "METADATA"),
        )
        connection.execute(
            "INSERT INTO embeddings(id, embedding_id, segment_id) VALUES (?, ?, ?)",
            (1, "record-1", "metadata-segment"),
        )
        connection.executemany(
            "INSERT INTO embedding_metadata VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, "chroma:document", "harmless copied fixture", None, None, None),
                (1, "wing", "synthetic", None, None, None),
            ],
        )
        connection.execute(
            "INSERT INTO embeddings_queue VALUES (?, ?, ?, ?)",
            (1, 2, "record-1", struct.pack("<ff", 1.25, -2.5)),
        )
        connection.commit()
    return target, receipt


def _effect_trap(name: str):
    def trap(*_args: object, **_kwargs: object) -> None:
        pytest.fail(f"preview reached prohibited effect sink: {name}")

    return trap


def test_exact_preview_is_inert_before_pickle_build_staging_and_swap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    source_before = (target / "chroma.sqlite3").read_bytes()
    old_staging = target.parent / f"{target.name}.rebuilt"
    old_staging.mkdir()
    sentinel = old_staging / "sentinel"
    sentinel.write_text("preserve", encoding="utf-8")
    monkeypatch.setattr(rebuild_from_disk, "read_index_vectors", _effect_trap("pickle"))
    monkeypatch.setattr(rebuild_from_disk, "build", _effect_trap("build"))
    monkeypatch.setattr(rebuild_from_disk, "allocate_recovery_attempt", _effect_trap("staging"))
    monkeypatch.setattr(rebuild_from_disk, "swap_staged_palace", _effect_trap("swap"))

    result = rebuild_from_disk.main(["--offline-target", str(target), "--receipt", str(receipt)])

    assert result == 0
    assert (target / "chroma.sqlite3").read_bytes() == source_before
    assert sentinel.read_text(encoding="utf-8") == "preserve"
    assert not list(target.parent.glob(".penny-exact-rebuild-*"))


def test_apply_without_separate_legacy_trust_is_inert(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    monkeypatch.setattr(rebuild_from_disk, "read_index_vectors", _effect_trap("pickle"))
    monkeypatch.setattr(rebuild_from_disk, "build", _effect_trap("build"))
    monkeypatch.setattr(rebuild_from_disk, "allocate_recovery_attempt", _effect_trap("staging"))

    result = rebuild_from_disk.main(
        ["--offline-target", str(target), "--receipt", str(receipt), "--apply"]
    )

    assert result == 1
    assert not list(target.parent.glob(".penny-exact-rebuild-*"))


def test_full_repair_apply_requires_separate_reembedding_authorization(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    monkeypatch.setattr(repair_palace, "_build", _effect_trap("Chroma build"))
    monkeypatch.setattr(repair_palace, "allocate_recovery_attempt", _effect_trap("staging"))

    result = repair_palace.main(
        ["--offline-target", str(target), "--receipt", str(receipt), "--apply"]
    )

    assert result == 1
    assert not list(target.parent.glob(".penny-reembedding-repair-*"))


def test_full_repair_preview_is_inert_before_chroma_build_staging_and_swap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    source_before = (target / "chroma.sqlite3").read_bytes()
    old_staging = target.parent / f"{target.name}.rebuild_tmp"
    old_staging.mkdir()
    sentinel = old_staging / "sentinel"
    sentinel.write_text("preserve", encoding="utf-8")
    monkeypatch.setattr(repair_palace, "_build", _effect_trap("Chroma build"))
    monkeypatch.setattr(repair_palace, "allocate_recovery_attempt", _effect_trap("staging"))
    monkeypatch.setattr(repair_palace, "swap_staged_palace", _effect_trap("swap"))

    result = repair_palace.main(["--offline-target", str(target), "--receipt", str(receipt)])

    assert result == 0
    assert (target / "chroma.sqlite3").read_bytes() == source_before
    assert sentinel.read_text(encoding="utf-8") == "preserve"
    assert not list(target.parent.glob(".penny-reembedding-repair-*"))


def test_changed_source_or_receipt_blocks_before_attempt_allocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    real_inspect = rebuild_from_disk.inspect_recovery_source

    def inspect_then_change_source(source, snapshot) -> rebuild_from_disk.SafeRecoveryInspection:
        inspection = real_inspect(source, snapshot)
        (source.target / "source-drift").write_text("changed", encoding="utf-8")
        return inspection

    monkeypatch.setattr(rebuild_from_disk, "inspect_recovery_source", inspect_then_change_source)
    monkeypatch.setattr(rebuild_from_disk, "allocate_recovery_attempt", _effect_trap("staging"))
    with pytest.raises(ValidationError, match="(source|identity) changed"):
        rebuild_from_disk.main(
            [
                "--offline-target",
                str(target),
                "--receipt",
                str(receipt),
                "--apply",
                "--trust-legacy-index-metadata",
            ]
        )


def test_changed_receipt_blocks_before_attempt_allocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    real_inspect = rebuild_from_disk.inspect_recovery_source

    def inspect_then_change_receipt(source, snapshot) -> rebuild_from_disk.SafeRecoveryInspection:
        inspection = real_inspect(source, snapshot)
        document = json.loads(receipt.read_text(encoding="utf-8"))
        document["approved_by"] = "different-test-owner"
        receipt.write_text(json.dumps(document), encoding="utf-8")
        receipt.chmod(0o600)
        return inspection

    monkeypatch.setattr(rebuild_from_disk, "inspect_recovery_source", inspect_then_change_receipt)
    monkeypatch.setattr(rebuild_from_disk, "allocate_recovery_attempt", _effect_trap("staging"))
    with pytest.raises(ValidationError, match="identity changed"):
        rebuild_from_disk.main(
            [
                "--offline-target",
                str(target),
                "--receipt",
                str(receipt),
                "--apply",
                "--trust-legacy-index-metadata",
            ]
        )


def test_source_is_revalidated_again_after_staging_before_swap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    real_revalidate = rebuild_from_disk.revalidate_source_binding
    calls = 0

    def revalidate_with_late_drift(source, snapshot):
        nonlocal calls
        calls += 1
        if calls == 3:
            (target / "late-drift").write_text("changed", encoding="utf-8")
        return real_revalidate(source, snapshot)

    def fake_build(stage, _records: object) -> None:
        (stage.access_path / "synthetic-stage").write_text("built", encoding="utf-8")

    monkeypatch.setattr(rebuild_from_disk, "revalidate_source_binding", revalidate_with_late_drift)
    monkeypatch.setattr(
        rebuild_from_disk,
        "read_index_vectors",
        lambda _source, _snapshot, _trust: {},
    )
    monkeypatch.setattr(rebuild_from_disk, "build", fake_build)
    monkeypatch.setattr(
        rebuild_from_disk,
        "verify",
        lambda _palace, _records: VerificationResult(True, "synthetic exact verification"),
    )
    monkeypatch.setattr(rebuild_from_disk, "swap_staged_palace", _effect_trap("swap"))

    result = rebuild_from_disk.main(
        [
            "--offline-target",
            str(target),
            "--receipt",
            str(receipt),
            "--apply",
            "--trust-legacy-index-metadata",
        ]
    )

    assert result == 1
    attempts = list(target.parent.glob(".penny-exact-rebuild-*"))
    assert len(attempts) == 1
    staged = next(path for path in attempts[0].iterdir() if path.name.startswith("staged-"))
    assert (staged / "synthetic-stage").is_file()
    assert target.is_dir()


def _add_harmless_legacy_segment(target: Path) -> None:
    with sqlite3.connect(target / "chroma.sqlite3") as connection:
        connection.execute("DELETE FROM embeddings_queue")
        connection.commit()
    segment = target / "00000000-0000-0000-0000-000000000001"
    segment.mkdir()
    size_per_element = 20
    data_offset = 4
    label_offset = 12
    header = b"\x00" * 4 + struct.pack(
        "<QQQQQQ", 0, 1, 1, size_per_element, label_offset, data_offset
    )
    (segment / "header.bin").write_bytes(header)
    (segment / "data_level0.bin").write_bytes(struct.pack("<IffQ", 0, 1.25, -2.5, 7))
    with (segment / "index_metadata.pickle").open("wb") as handle:
        pickle.dump({"label_to_id": {7: "record-1"}}, handle)


def test_trusted_metadata_file_race_never_deserializes_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    _add_harmless_legacy_segment(target)
    segment = target / "00000000-0000-0000-0000-000000000001"
    outside = tmp_path / "outside.pickle"
    with outside.open("wb") as handle:
        pickle.dump({"label_to_id": {7: "outside"}}, handle)
    real_hold = rebuild_from_disk.hold_regular_file
    deserialized: list[bool] = []

    def racing_hold(parent, name: str, expected):
        if name == "index_metadata.pickle" and not (segment / "metadata-held").exists():
            (segment / "index_metadata.pickle").rename(segment / "metadata-held")
            (segment / "index_metadata.pickle").symlink_to(outside)
        return real_hold(parent, name, expected)

    def track_pickle(*args, **kwargs):
        deserialized.append(True)
        return {"label_to_id": {}}

    with open_authorized_recovery(target, receipt) as source:
        snapshot = snapshot_source_tree(source)
        trust = rebuild_from_disk._legacy_trust(source, snapshot)
        monkeypatch.setattr(rebuild_from_disk, "hold_regular_file", racing_hold)
        monkeypatch.setattr(rebuild_from_disk, "_trusted_pickle", track_pickle)
        with pytest.raises(ValidationError, match="changed before use"):
            rebuild_from_disk.read_index_vectors(source, snapshot, trust)

    assert deserialized == []


def test_explicitly_trusted_harmless_exact_recovery_verifies_and_preserves_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target, receipt = _exact_sqlite_fixture(tmp_path)
    _add_harmless_legacy_segment(target)
    archive = target / "archive"
    archive.mkdir()
    (archive / "keep.txt").write_text("preserved non-Chroma data", encoding="utf-8")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "False")

    result = rebuild_from_disk.main(
        [
            "--offline-target",
            str(target),
            "--receipt",
            str(receipt),
            "--apply",
            "--trust-legacy-index-metadata",
        ]
    )

    assert result == 0
    attempts = list(target.parent.glob(".penny-exact-rebuild-*"))
    assert len(attempts) == 1
    assert (attempts[0] / "original" / "chroma.sqlite3").is_file()
    assert (attempts[0] / "original" / "00000000-0000-0000-0000-000000000001").is_dir()
    assert target.is_dir()
    assert not (target / "00000000-0000-0000-0000-000000000001").exists()
    assert (target / "archive" / "keep.txt").read_text(encoding="utf-8") == (
        "preserved non-Chroma data"
    )
    assert (attempts[0] / "original" / "archive" / "keep.txt").is_file()
