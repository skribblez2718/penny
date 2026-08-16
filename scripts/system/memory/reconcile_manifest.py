"""Compare source and migrated-copy manifests by logical identity and canonical hash."""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Sequence

from .common import ValidationError, atomic_write_json, require_absolute_path, sha256_file, utc_now
from .manifest_core import (
    SCHEMA_VERSION,
    LogicalRecord,
    logical_records_from_manifest,
    validate_copy_receipt,
    validate_export_manifest,
)

RECONCILIATION_RECEIPT_TYPE = "memory-logical-reconciliation"


def _difference_entry(record: LogicalRecord) -> dict[str, str]:
    return {
        "record_class": record.record_class,
        "record_id": record.record_id,
        "logical_hash": record.logical_hash,
    }


def reconcile_manifests(
    source_manifest_path: Path,
    destination_manifest_path: Path,
    source_copy_receipt_path: Path,
    destination_copy_receipt_path: Path,
    output: Path,
) -> dict[str, Any]:
    """Write an exact logical equality receipt for two immutable copied corpora."""

    source_manifest_path = require_absolute_path(str(source_manifest_path), "source")
    destination_manifest_path = require_absolute_path(str(destination_manifest_path), "destination")
    source_copy_receipt_path = require_absolute_path(
        str(source_copy_receipt_path), "source_copy_receipt"
    )
    destination_copy_receipt_path = require_absolute_path(
        str(destination_copy_receipt_path), "destination_copy_receipt"
    )
    output = require_absolute_path(str(output), "output", must_exist=False)
    if source_manifest_path == destination_manifest_path:
        raise ValidationError("source and destination manifests must be distinct copies")

    source_manifest = validate_export_manifest(source_manifest_path)
    destination_manifest = validate_export_manifest(destination_manifest_path)
    validate_copy_receipt(source_copy_receipt_path, source_manifest_path, source_manifest)
    validate_copy_receipt(
        destination_copy_receipt_path,
        destination_manifest_path,
        destination_manifest,
    )
    source_records = {
        record.key: record for record in logical_records_from_manifest(source_manifest)
    }
    destination_records = {
        record.key: record for record in logical_records_from_manifest(destination_manifest)
    }

    source_keys = set(source_records)
    destination_keys = set(destination_records)
    missing = [source_records[key] for key in sorted(source_keys - destination_keys)]
    extra = [destination_records[key] for key in sorted(destination_keys - source_keys)]
    changed: list[dict[str, str]] = []
    for key in sorted(source_keys & destination_keys):
        source_record = source_records[key]
        destination_record = destination_records[key]
        if source_record.logical_hash != destination_record.logical_hash:
            changed.append(
                {
                    "record_class": source_record.record_class,
                    "record_id": source_record.record_id,
                    "source_hash": source_record.logical_hash,
                    "destination_hash": destination_record.logical_hash,
                }
            )

    logical_equal = not missing and not extra and not changed
    source_class_counts = Counter(record.record_class for record in source_records.values())
    destination_class_counts = Counter(
        record.record_class for record in destination_records.values()
    )
    receipt: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "receipt_type": RECONCILIATION_RECEIPT_TYPE,
        "reconciled_at": utc_now(),
        "source": {
            "source_id": source_manifest["source_id"],
            "manifest_sha256": sha256_file(source_manifest_path),
            "copy_receipt_sha256": sha256_file(source_copy_receipt_path),
            "record_count": len(source_records),
            "class_counts": dict(sorted(source_class_counts.items())),
        },
        "destination": {
            "source_id": destination_manifest["source_id"],
            "manifest_sha256": sha256_file(destination_manifest_path),
            "copy_receipt_sha256": sha256_file(destination_copy_receipt_path),
            "record_count": len(destination_records),
            "class_counts": dict(sorted(destination_class_counts.items())),
        },
        "missing": [_difference_entry(record) for record in missing],
        "extra": [_difference_entry(record) for record in extra],
        "changed": changed,
        "logical_equal": logical_equal,
    }
    atomic_write_json(output, receipt)
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconcile two immutable memory-copy manifests")
    parser.add_argument("--source", required=True, type=Path, help="source export manifest")
    parser.add_argument(
        "--destination", required=True, type=Path, help="migrated-copy export manifest"
    )
    parser.add_argument("--source-copy-receipt", required=True, type=Path)
    parser.add_argument("--destination-copy-receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; return one on proven inequality and two on invalid input."""

    args = _parser().parse_args(argv)
    try:
        receipt = reconcile_manifests(
            args.source,
            args.destination,
            args.source_copy_receipt,
            args.destination_copy_receipt,
            args.output,
        )
    except (OSError, ValidationError) as exc:
        print(f"reconciliation failed: {exc}", file=sys.stderr)
        return 2
    print("equal" if receipt["logical_equal"] else "different")
    return 0 if receipt["logical_equal"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
