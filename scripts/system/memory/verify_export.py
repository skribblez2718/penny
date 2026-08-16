"""Independently verify an immutable memory export without opening live storage."""

from __future__ import annotations

import argparse
import os
import stat
import sys
from pathlib import Path
from typing import Any, Sequence

from .common import (
    ValidationError,
    atomic_write_json,
    mode_string,
    require_absolute_path,
    sha256_file,
    utc_now,
)
from .manifest_core import (
    SCHEMA_VERSION,
    validate_copy_receipt,
    validate_drain_receipt,
    validate_export_manifest,
)

EXPECTED_FILE_MODE = "0400"
EXPECTED_DIRECTORY_MODE = "0500"
VERIFY_RECEIPT_TYPE = "immutable-memory-copy-verification"


def _payload_files(payload_root: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for root, directory_names, file_names in os.walk(payload_root, followlinks=False):
        root_path = Path(root)
        if root_path.is_symlink():
            raise ValidationError(f"export contains a symlink directory: {root_path}")
        if mode_string(root_path.stat().st_mode) != EXPECTED_DIRECTORY_MODE:
            raise ValidationError(
                f"export directory is writable or has unexpected mode: {root_path}"
            )
        directory_names.sort()
        file_names.sort()
        for directory_name in directory_names:
            if (root_path / directory_name).is_symlink():
                raise ValidationError(f"export contains a symlink directory: {directory_name}")
        for file_name in file_names:
            candidate = root_path / file_name
            if candidate.is_symlink() or not candidate.is_file():
                raise ValidationError(f"export contains a non-regular file: {candidate}")
            relative = candidate.relative_to(payload_root).as_posix()
            files[relative] = candidate
    return files


def _validate_metadata(
    destination: Path,
    source_manifest: Path,
    drain_receipt_path: Path,
) -> tuple[dict[str, Any], Path]:
    if not destination.is_dir() or destination.is_symlink():
        raise ValidationError("destination must be a non-symlink export directory")
    expected_manifest = destination / "manifest.json"
    if source_manifest != expected_manifest.resolve(strict=True):
        raise ValidationError("source manifest must be destination/manifest.json")
    expected_root_entries = {"manifest.json", "copy-receipt.json", "payload"}
    if {entry.name for entry in destination.iterdir()} != expected_root_entries:
        raise ValidationError("export root contains missing or unexpected entries")

    manifest = validate_export_manifest(source_manifest)
    copy_receipt_path = destination / "copy-receipt.json"
    validate_copy_receipt(copy_receipt_path, source_manifest, manifest)
    drain = validate_drain_receipt(drain_receipt_path)
    if manifest["drain_receipt_sha256"] != sha256_file(drain_receipt_path):
        raise ValidationError("manifest does not bind the supplied drain receipt")
    if manifest["source_id"] != drain["source_id"]:
        raise ValidationError("manifest source_id does not match drain receipt")
    for protected_file in (source_manifest, copy_receipt_path):
        if mode_string(protected_file.stat().st_mode) != EXPECTED_FILE_MODE:
            raise ValidationError(f"immutable metadata file has unexpected mode: {protected_file}")
    if mode_string(destination.stat().st_mode) != EXPECTED_DIRECTORY_MODE:
        raise ValidationError("export root mode is not immutable owner-only")
    return manifest, copy_receipt_path


def _verify_payload(destination: Path, manifest: dict[str, Any]) -> tuple[int, int]:
    payload_root = destination / "payload"
    if not payload_root.is_dir() or payload_root.is_symlink():
        raise ValidationError("export payload directory is missing or unsafe")
    actual_files = _payload_files(payload_root)
    raw_manifest_files = manifest["files"]
    if not isinstance(raw_manifest_files, list):
        raise ValidationError("manifest files must be a list")
    expected_paths = {str(record["path"]) for record in raw_manifest_files}
    if set(actual_files) != expected_paths:
        missing = sorted(expected_paths - set(actual_files))
        extra = sorted(set(actual_files) - expected_paths)
        raise ValidationError(f"payload inventory mismatch; missing={missing}, extra={extra}")

    total_bytes = 0
    for record in raw_manifest_files:
        path = actual_files[str(record["path"])]
        file_stat = path.stat()
        if not stat.S_ISREG(file_stat.st_mode):
            raise ValidationError(f"payload entry is not a regular file: {path}")
        if mode_string(file_stat.st_mode) != record["export_mode"]:
            raise ValidationError(f"payload mode mismatch: {record['path']}")
        if file_stat.st_size != record["size"]:
            raise ValidationError(f"payload size mismatch: {record['path']}")
        if sha256_file(path) != record["sha256"]:
            raise ValidationError(f"payload hash mismatch: {record['path']}")
        total_bytes += file_stat.st_size
    return len(actual_files), total_bytes


def verify_export(
    source_manifest: Path,
    destination: Path,
    drain_receipt_path: Path,
    output: Path,
) -> dict[str, Any]:
    """Verify bytes, modes, inventory closure, and receipt hash bindings."""

    source_manifest = require_absolute_path(str(source_manifest), "source_manifest")
    destination = require_absolute_path(str(destination), "destination")
    drain_receipt_path = require_absolute_path(str(drain_receipt_path), "drain_receipt")
    output = require_absolute_path(str(output), "output", must_exist=False)
    manifest, copy_receipt_path = _validate_metadata(
        destination,
        source_manifest,
        drain_receipt_path,
    )
    file_count, total_bytes = _verify_payload(destination, manifest)
    receipt: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "receipt_type": VERIFY_RECEIPT_TYPE,
        "verified_at": utc_now(),
        "source_id": manifest["source_id"],
        "manifest_sha256": sha256_file(source_manifest),
        "copy_receipt_sha256": sha256_file(copy_receipt_path),
        "drain_receipt_sha256": sha256_file(drain_receipt_path),
        "file_count": file_count,
        "total_bytes": total_bytes,
        "logical_record_count": manifest["summary"]["logical_record_count"],
        "independently_readable": True,
        "verified": True,
    }
    atomic_write_json(output, receipt)
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify an immutable memory export")
    parser.add_argument("--source", required=True, type=Path, help="export manifest path")
    parser.add_argument("--destination", required=True, type=Path, help="export root")
    parser.add_argument("--drain-receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point with explicit source, destination, prerequisite, and output."""

    args = _parser().parse_args(argv)
    try:
        receipt = verify_export(
            args.source,
            args.destination,
            args.drain_receipt,
            args.output,
        )
    except (OSError, ValidationError) as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        return 2
    print(receipt["manifest_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
