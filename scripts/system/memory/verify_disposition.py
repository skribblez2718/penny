"""Verify disposition coverage, source hashes, status vocabulary, and candidate sets."""

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
    SAFE_DEFAULT_DESTINATION,
    SAFE_DEFAULT_POLICY,
    SAFE_DEFAULT_REASON,
    validate_disposition_manifest,
)
from .manifest_core import (
    SCHEMA_VERSION,
    logical_records_from_manifest,
    validate_copy_receipt,
    validate_export_manifest,
)

DISPOSITION_VERIFY_RECEIPT_TYPE = "memory-disposition-verification"


def _validate_source_coverage(
    source_manifest: dict[str, Any],
    records: list[dict[str, Any]],
) -> None:
    raw_classes = source_manifest.get("disposition_record_classes")
    if not isinstance(raw_classes, list):
        raise ValidationError("source manifest lacks disposition record classes")
    disposition_classes = set(raw_classes)
    source_records = {
        record.key: record
        for record in logical_records_from_manifest(source_manifest)
        if record.record_class in disposition_classes
    }
    dispositions = {(record["record_class"], record["record_id"]): record for record in records}
    if set(dispositions) != set(source_records):
        missing = sorted(set(source_records) - set(dispositions))
        extra = sorted(set(dispositions) - set(source_records))
        raise ValidationError(f"disposition coverage mismatch; missing={missing}, extra={extra}")
    for key, source_record in source_records.items():
        if dispositions[key]["source_hash"] != source_record.logical_hash:
            raise ValidationError(f"disposition source hash mismatch: {key}")


def _validate_review_and_candidates(
    disposition_document: dict[str, Any],
    records: list[dict[str, Any]],
    require_approved: bool,
) -> None:
    for record in records:
        if record["reviewer"] is None:
            safe_default = (
                not record["approved"]
                and record["status"] == "quarantine"
                and record["policy"] == SAFE_DEFAULT_POLICY
                and record["reason"] == SAFE_DEFAULT_REASON
                and record["destination"] == SAFE_DEFAULT_DESTINATION
            )
            if not safe_default:
                raise ValidationError("unreviewed records must use the safe quarantine default")
    if require_approved and any(not record["approved"] for record in records):
        raise ValidationError("operator approval required but disposition has pending records")

    expected_full = [
        {
            "record_class": record["record_class"],
            "record_id": record["record_id"],
            "source_hash": record["source_hash"],
        }
        for record in records
    ]
    expected_curated = [
        candidate for candidate, record in zip(expected_full, records) if record["status"] == "hot"
    ]
    if disposition_document.get("full_candidate") != expected_full:
        raise ValidationError("full candidate does not contain every source record exactly once")
    if disposition_document.get("curated_candidate") != expected_curated:
        raise ValidationError("curated candidate is not exactly the approved hot selection")


def verify_disposition(
    source_manifest_path: Path,
    destination_path: Path,
    copy_receipt_path: Path,
    output: Path,
    *,
    require_approved: bool = False,
) -> dict[str, Any]:
    """Prove 100% drawer/KG coverage and exact full/curated candidate membership."""

    source_manifest_path = require_absolute_path(str(source_manifest_path), "source")
    destination_path = require_absolute_path(str(destination_path), "destination")
    copy_receipt_path = require_absolute_path(str(copy_receipt_path), "copy_receipt")
    output = require_absolute_path(str(output), "output", must_exist=False)
    source_manifest = validate_export_manifest(source_manifest_path)
    validate_copy_receipt(copy_receipt_path, source_manifest_path, source_manifest)
    disposition_document = load_json_object(destination_path)
    records = validate_disposition_manifest(disposition_document)

    if disposition_document["source_id"] != source_manifest["source_id"]:
        raise ValidationError("disposition source_id does not match source manifest")
    if disposition_document["source_manifest_sha256"] != sha256_file(source_manifest_path):
        raise ValidationError("disposition source manifest hash mismatch")
    if disposition_document["source_copy_receipt_sha256"] != sha256_file(copy_receipt_path):
        raise ValidationError("disposition copy receipt hash mismatch")
    _validate_source_coverage(source_manifest, records)
    _validate_review_and_candidates(disposition_document, records, require_approved)

    receipt: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "receipt_type": DISPOSITION_VERIFY_RECEIPT_TYPE,
        "verified_at": utc_now(),
        "source_id": source_manifest["source_id"],
        "source_manifest_sha256": sha256_file(source_manifest_path),
        "source_copy_receipt_sha256": sha256_file(copy_receipt_path),
        "disposition_sha256": sha256_file(destination_path),
        "record_count": len(records),
        "approved_count": disposition_document["summary"]["approved_count"],
        "pending_count": disposition_document["summary"]["pending_count"],
        "full_coverage": True,
        "allowed_statuses_only": True,
        "full_candidate_complete": True,
        "curated_candidate_exact": True,
        "approval_required": require_approved,
        "verified": True,
    }
    atomic_write_json(output, receipt)
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify a full-coverage memory disposition")
    parser.add_argument("--source", required=True, type=Path, help="immutable export manifest")
    parser.add_argument("--destination", required=True, type=Path, help="disposition manifest")
    parser.add_argument("--copy-receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--require-approved", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point with optional operator-approval gate."""

    args = _parser().parse_args(argv)
    try:
        receipt = verify_disposition(
            args.source,
            args.destination,
            args.copy_receipt,
            args.output,
            require_approved=args.require_approved,
        )
    except (OSError, ValidationError) as exc:
        print(f"disposition verification failed: {exc}", file=sys.stderr)
        return 2
    print(receipt["record_count"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
