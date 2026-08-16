"""Build a full-coverage, non-destructive disposition manifest from an immutable copy."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Sequence

from .common import (
    ValidationError,
    atomic_write_json,
    load_json_object,
    require_absolute_path,
    sha256_file,
    utc_now,
)
from .disposition_core import (
    DISPOSITION_DECISIONS_TYPE,
    DISPOSITION_MANIFEST_TYPE,
    REVERSIBILITY_BASIS,
    SAFE_DEFAULT_DESTINATION,
    SAFE_DEFAULT_POLICY,
    SAFE_DEFAULT_REASON,
    expected_disposition_summary,
    validate_disposition_entry,
)
from .manifest_core import (
    SCHEMA_VERSION,
    logical_records_from_manifest,
    validate_copy_receipt,
    validate_export_manifest,
)


def _load_decisions(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    document = load_json_object(path)
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ValidationError(f"decisions schema_version must be {SCHEMA_VERSION}")
    if document.get("document_type") != DISPOSITION_DECISIONS_TYPE:
        raise ValidationError(f"decisions document_type must be {DISPOSITION_DECISIONS_TYPE}")
    if set(document) != {"schema_version", "document_type", "decisions"}:
        raise ValidationError("decisions document has unknown or missing fields")
    raw_decisions = document.get("decisions")
    if not isinstance(raw_decisions, list):
        raise ValidationError("decisions must be a list")
    decisions: dict[tuple[str, str], dict[str, Any]] = {}
    for index, raw_decision in enumerate(raw_decisions):
        decision = validate_disposition_entry(
            raw_decision,
            f"decisions[{index}]",
            allow_pending_reviewer=False,
        )
        key = (decision["record_class"], decision["record_id"])
        if key in decisions:
            raise ValidationError(f"duplicate disposition decision: {key}")
        decisions[key] = decision
    return decisions


def build_disposition(
    source_manifest_path: Path,
    destination: Path,
    copy_receipt_path: Path,
    decisions_path: Path,
) -> dict[str, Any]:
    """Cover every configured drawer/KG class, quarantining undecided records safely."""

    source_manifest_path = require_absolute_path(str(source_manifest_path), "source")
    destination = require_absolute_path(str(destination), "destination", must_exist=False)
    copy_receipt_path = require_absolute_path(str(copy_receipt_path), "copy_receipt")
    decisions_path = require_absolute_path(str(decisions_path), "decisions")
    source_manifest = validate_export_manifest(source_manifest_path)
    validate_copy_receipt(copy_receipt_path, source_manifest_path, source_manifest)
    decisions = _load_decisions(decisions_path)

    raw_classes = source_manifest.get("disposition_record_classes")
    if not isinstance(raw_classes, list):
        raise ValidationError("source manifest lacks disposition record classes")
    disposition_classes = set(raw_classes)
    source_records = {
        record.key: record
        for record in logical_records_from_manifest(source_manifest)
        if record.record_class in disposition_classes
    }
    unknown_decisions = set(decisions) - set(source_records)
    if unknown_decisions:
        raise ValidationError(
            f"decisions reference unknown source records: {sorted(unknown_decisions)}"
        )

    records: list[dict[str, Any]] = []
    for key, source_record in sorted(source_records.items()):
        decision = decisions.get(key)
        if decision is None:
            decision = {
                "record_class": source_record.record_class,
                "record_id": source_record.record_id,
                "source_hash": source_record.logical_hash,
                "status": "quarantine",
                "reason": SAFE_DEFAULT_REASON,
                "destination": SAFE_DEFAULT_DESTINATION,
                "reviewer": None,
                "policy": SAFE_DEFAULT_POLICY,
                "reversible": True,
                "reversibility_basis": REVERSIBILITY_BASIS,
                "approved": False,
            }
        elif decision["source_hash"] != source_record.logical_hash:
            raise ValidationError(f"decision source hash mismatch: {key}")
        records.append(decision)

    candidate_records = [
        {
            "record_class": record["record_class"],
            "record_id": record["record_id"],
            "source_hash": record["source_hash"],
        }
        for record in records
    ]
    curated_records = [
        record
        for record, disposition in zip(candidate_records, records)
        if disposition["status"] == "hot"
    ]
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "manifest_type": DISPOSITION_MANIFEST_TYPE,
        "created_at": utc_now(),
        "source_id": source_manifest["source_id"],
        "source_manifest_sha256": sha256_file(source_manifest_path),
        "source_copy_receipt_sha256": sha256_file(copy_receipt_path),
        "records": records,
        "full_candidate": candidate_records,
        "curated_candidate": curated_records,
        "summary": expected_disposition_summary(records),
    }
    atomic_write_json(destination, manifest)
    return manifest


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a full-coverage memory disposition")
    parser.add_argument("--source", required=True, type=Path, help="immutable export manifest")
    parser.add_argument("--destination", required=True, type=Path, help="new disposition path")
    parser.add_argument("--copy-receipt", required=True, type=Path)
    parser.add_argument("--decisions", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; never mutates or deletes source/candidate data."""

    args = _parser().parse_args(argv)
    try:
        manifest = build_disposition(
            args.source,
            args.destination,
            args.copy_receipt,
            args.decisions,
        )
    except (OSError, ValidationError) as exc:
        print(f"disposition build failed: {exc}", file=sys.stderr)
        return 2
    print(manifest["summary"]["record_count"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
