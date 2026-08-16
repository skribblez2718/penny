from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from memory.build_disposition import build_disposition
from memory.common import ValidationError, sha256_file
from memory.export_manifest import build_export
from memory.reconcile_manifest import reconcile_manifests
from memory.verify_disposition import verify_disposition
from memory.verify_export import verify_export

DATA_FILES = {
    "drawers/rows.jsonl": b'{"id":"drawer-1"}\n',
    "chunks/metadata.json": b'{"group":"group-1"}\n',
    "kg/graph.sqlite3": b"synthetic-kg",
    "diary/entries.jsonl": b'{"date":"2026-08-15"}\n',
    "config/mempalace.json": b'{"schema":1}\n',
    "native/chroma.sqlite3": b"synthetic-chroma",
    "native/index.bin": b"synthetic-index",
    "wal/chroma.sqlite3-wal": b"synthetic-wal",
    "archives/cold.jsonl": b'{"id":"archive-1"}\n',
    "sidecars/lifecycle.sqlite3": b"synthetic-sidecar",
    "journals/operations.jsonl": b'{"op":"op-1"}\n',
}
PATH_RULES = [
    ("drawers/*", "drawers"),
    ("chunks/*", "chunk-metadata"),
    ("kg/*", "kg"),
    ("diary/*", "diary"),
    ("config/*", "config"),
    ("native/*", "native-segments"),
    ("wal/*", "wal-shm"),
    ("archives/*", "archives"),
    ("sidecars/*", "sidecars"),
    ("journals/*", "operation-journals"),
]
LOGICAL_VALUES: list[dict[str, Any]] = [
    {"record_class": "drawer", "record_id": "drawer-1", "value": {"content": "alpha"}},
    {
        "record_class": "chunk_group",
        "record_id": "group-1",
        "value": {"chunks": ["alpha"]},
    },
    {"record_class": "kg", "record_id": "triple-1", "value": {"s": "a", "p": "b", "o": "c"}},
    {"record_class": "diary", "record_id": "diary-1", "value": {"text": "synthetic"}},
    {"record_class": "archive", "record_id": "archive-1", "value": {"text": "cold"}},
    {"record_class": "sidecar", "record_id": "sidecar-1", "value": {"state": "derived"}},
]


def _write_json(path: Path, value: object, mode: int = 0o600) -> Path:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(mode)
    return path


def _fixture_inputs(
    root: Path,
    *,
    source_id: str,
    logical_values: list[dict[str, Any]] | None = None,
) -> tuple[Path, Path, Path, Path]:
    source = root / "source-palace-copy"
    source.mkdir(mode=0o700, parents=True)
    for relative, content in DATA_FILES.items():
        path = source / relative
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(content)
    drain = _write_json(
        root / "drain.json",
        {
            "schema_version": 1,
            "receipt_type": "memory-drain",
            "source_id": source_id,
            "authority_timestamp": "2026-08-15T12:00:00Z",
            "approved_by": "synthetic-test-owner",
            "checks": {
                "writers": True,
                "raw_clients": True,
                "locks": True,
                "leases": True,
                "wal_safe": True,
            },
        },
    )
    inventory = _write_json(
        root / "inventory.json",
        {
            "schema_version": 1,
            "path_rules": [
                {"pattern": pattern, "data_class": data_class} for pattern, data_class in PATH_RULES
            ],
            "required_data_classes": sorted({data_class for _, data_class in PATH_RULES}),
            "required_logical_classes": [
                "drawer",
                "chunk_group",
                "kg",
                "diary",
                "archive",
                "sidecar",
            ],
            "disposition_record_classes": ["drawer", "kg"],
        },
    )
    logical = _write_json(
        root / "logical.json",
        {"schema_version": 1, "records": logical_values or LOGICAL_VALUES},
    )
    return source, drain, inventory, logical


def _export(root: Path, *, source_id: str, values: list[dict[str, Any]] | None = None) -> Path:
    source, drain, inventory, logical = _fixture_inputs(
        root,
        source_id=source_id,
        logical_values=values,
    )
    destination = root / "immutable-export"
    build_export(source, destination, drain, inventory, logical)
    return destination


def test_export_is_complete_read_only_and_independently_verifiable(tmp_path: Path) -> None:
    source, drain, inventory, logical = _fixture_inputs(tmp_path, source_id="source-a")
    source_hashes = {path: sha256_file(source / path) for path in DATA_FILES}
    destination = tmp_path / "export"

    receipt = build_export(source, destination, drain, inventory, logical)
    verification = verify_export(
        destination / "manifest.json",
        destination,
        drain,
        tmp_path / "verify-receipt.json",
    )

    assert receipt["immutable_modes"] is True
    assert verification["verified"] is True
    assert verification["file_count"] == len(DATA_FILES)
    assert oct(destination.stat().st_mode & 0o777) == "0o500"
    for relative, digest in source_hashes.items():
        assert sha256_file(source / relative) == digest
        exported = destination / "payload" / relative
        assert sha256_file(exported) == digest
        assert oct(exported.stat().st_mode & 0o777) == "0o400"


def test_export_requires_safe_drain_and_refuses_overwrite(tmp_path: Path) -> None:
    source, drain, inventory, logical = _fixture_inputs(tmp_path, source_id="source-a")
    drain.chmod(0o600)
    document = json.loads(drain.read_text(encoding="utf-8"))
    document["checks"]["writers"] = False
    drain.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ValidationError, match="unsafe checks"):
        build_export(source, tmp_path / "export", drain, inventory, logical)

    document["checks"]["writers"] = True
    drain.write_text(json.dumps(document), encoding="utf-8")
    destination = tmp_path / "export"
    build_export(source, destination, drain, inventory, logical)
    with pytest.raises(ValidationError, match="already exists"):
        build_export(source, destination, drain, inventory, logical)


def test_reconcile_uses_logical_hashes_not_physical_counts(tmp_path: Path) -> None:
    source_export = _export(tmp_path / "source", source_id="source-a")
    equal_export = _export(tmp_path / "equal", source_id="candidate-a")
    changed_values = [dict(record) for record in LOGICAL_VALUES]
    changed_values[0] = {
        "record_class": "drawer",
        "record_id": "drawer-1",
        "value": {"content": "changed"},
    }
    changed_export = _export(
        tmp_path / "changed",
        source_id="candidate-b",
        values=changed_values,
    )

    equal_receipt = reconcile_manifests(
        source_export / "manifest.json",
        equal_export / "manifest.json",
        source_export / "copy-receipt.json",
        equal_export / "copy-receipt.json",
        tmp_path / "equal-reconciliation.json",
    )
    changed_receipt = reconcile_manifests(
        source_export / "manifest.json",
        changed_export / "manifest.json",
        source_export / "copy-receipt.json",
        changed_export / "copy-receipt.json",
        tmp_path / "changed-reconciliation.json",
    )

    assert equal_receipt["logical_equal"] is True
    assert equal_receipt["missing"] == []
    assert changed_receipt["logical_equal"] is False
    assert changed_receipt["missing"] == []
    assert changed_receipt["extra"] == []
    assert [entry["record_id"] for entry in changed_receipt["changed"]] == ["drawer-1"]


def test_disposition_has_full_coverage_and_separate_curated_candidate(tmp_path: Path) -> None:
    export = _export(tmp_path / "source", source_id="source-a")
    manifest = json.loads((export / "manifest.json").read_text(encoding="utf-8"))
    hashes = {
        (record["record_class"], record["record_id"]): record["logical_hash"]
        for record in manifest["logical_records"]
    }
    decisions = _write_json(
        tmp_path / "decisions.json",
        {
            "schema_version": 1,
            "document_type": "memory-disposition-decisions",
            "decisions": [
                {
                    "record_class": "drawer",
                    "record_id": "drawer-1",
                    "source_hash": hashes[("drawer", "drawer-1")],
                    "status": "hot",
                    "reason": "Synthetic fixture selected for hot recall",
                    "destination": "candidate/hot",
                    "reviewer": "synthetic-reviewer",
                    "policy": "synthetic-policy/v1",
                    "reversible": True,
                    "reversibility_basis": "Immutable source export remains readable",
                    "approved": True,
                },
                {
                    "record_class": "kg",
                    "record_id": "triple-1",
                    "source_hash": hashes[("kg", "triple-1")],
                    "status": "legacy-archive",
                    "reason": "Synthetic fixture retained outside hot recall",
                    "destination": "candidate/archive",
                    "reviewer": "synthetic-reviewer",
                    "policy": "synthetic-policy/v1",
                    "reversible": True,
                    "reversibility_basis": "Immutable source export remains readable",
                    "approved": True,
                },
            ],
        },
    )
    disposition_path = tmp_path / "disposition.json"
    disposition = build_disposition(
        export / "manifest.json",
        disposition_path,
        export / "copy-receipt.json",
        decisions,
    )
    verification = verify_disposition(
        export / "manifest.json",
        disposition_path,
        export / "copy-receipt.json",
        tmp_path / "disposition-verification.json",
        require_approved=True,
    )

    assert disposition["summary"]["record_count"] == 2
    assert len(disposition["full_candidate"]) == 2
    assert [entry["record_id"] for entry in disposition["curated_candidate"]] == ["drawer-1"]
    assert verification["full_coverage"] is True
    assert verification["allowed_statuses_only"] is True


def test_missing_decisions_are_quarantined_and_cannot_pass_approval_gate(
    tmp_path: Path,
) -> None:
    export = _export(tmp_path / "source", source_id="source-a")
    decisions = _write_json(
        tmp_path / "decisions.json",
        {
            "schema_version": 1,
            "document_type": "memory-disposition-decisions",
            "decisions": [],
        },
    )
    disposition_path = tmp_path / "disposition.json"
    disposition = build_disposition(
        export / "manifest.json",
        disposition_path,
        export / "copy-receipt.json",
        decisions,
    )

    assert {record["status"] for record in disposition["records"]} == {"quarantine"}
    assert disposition["summary"]["pending_count"] == 2
    with pytest.raises(ValidationError, match="approval required"):
        verify_disposition(
            export / "manifest.json",
            disposition_path,
            export / "copy-receipt.json",
            tmp_path / "must-not-exist.json",
            require_approved=True,
        )


def test_copy_receipt_is_a_required_hash_bound_prerequisite(tmp_path: Path) -> None:
    export = _export(tmp_path / "source", source_id="source-a")
    copied_receipt = tmp_path / "tampered-copy-receipt.json"
    receipt = json.loads((export / "copy-receipt.json").read_text(encoding="utf-8"))
    receipt["manifest_sha256"] = "0" * 64
    _write_json(copied_receipt, receipt)
    decisions = _write_json(
        tmp_path / "decisions.json",
        {
            "schema_version": 1,
            "document_type": "memory-disposition-decisions",
            "decisions": [],
        },
    )

    with pytest.raises(ValidationError, match="manifest hash mismatch"):
        build_disposition(
            export / "manifest.json",
            tmp_path / "disposition.json",
            copied_receipt,
            decisions,
        )


def test_source_and_destination_arguments_have_no_live_path_defaults() -> None:
    scripts = [
        "export_manifest.py",
        "verify_export.py",
        "reconcile_manifest.py",
        "build_disposition.py",
        "verify_disposition.py",
    ]
    base = Path(__file__).parents[1]
    for script in scripts:
        source = (base / script).read_text(encoding="utf-8")
        assert re.search(r'add_argument\("--source".*?required=True', source, re.DOTALL)
        assert re.search(r'add_argument\(\s*"--destination".*?required=True', source, re.DOTALL)
        assert ".mempalace" not in source
        assert "PersistentClient" not in source
