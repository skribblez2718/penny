"""Create a new immutable, hash-bound copy of an explicitly drained memory root."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Sequence

from .common import (
    ValidationError,
    atomic_write_json,
    mode_string,
    require_absolute_path,
    sha256_file,
    utc_now,
)
from .manifest_core import (
    COPY_RECEIPT_TYPE,
    EXPORT_MANIFEST_TYPE,
    SCHEMA_VERSION,
    classify_path,
    load_inventory,
    load_logical_records,
    payload_tree_hash,
    require_class_coverage,
    validate_drain_receipt,
)

EXPORT_FILE_MODE = 0o400
EXPORT_DIRECTORY_MODE = 0o500
COPY_BUFFER_BYTES = 1024 * 1024


def _paths_overlap(first: Path, second: Path) -> bool:
    try:
        first.relative_to(second)
        return True
    except ValueError:
        pass
    try:
        second.relative_to(first)
        return True
    except ValueError:
        return False


def _copy_regular_file(source: Path, destination: Path) -> tuple[int, int]:
    """Copy one file without following symlinks and detect concurrent mutation."""

    source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    source_fd = os.open(source, source_flags)
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValidationError(f"source contains a non-regular file: {source}")
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            while True:
                chunk = os.read(source_fd, COPY_BUFFER_BYTES)
                if not chunk:
                    break
                remaining = memoryview(chunk)
                while remaining:
                    written = os.write(destination_fd, remaining)
                    if written <= 0:
                        raise OSError("short write while creating immutable export")
                    remaining = remaining[written:]
            os.fsync(destination_fd)
            os.fchmod(destination_fd, EXPORT_FILE_MODE)
        finally:
            os.close(destination_fd)
        after = os.fstat(source_fd)
    finally:
        os.close(source_fd)
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        raise ValidationError(f"source changed after drain while copying: {source}")
    return before.st_size, before.st_mode


def _source_files(source: Path) -> list[Path]:
    files: list[Path] = []
    for root, directory_names, file_names in os.walk(source, followlinks=False):
        root_path = Path(root)
        directory_names.sort()
        file_names.sort()
        for directory_name in directory_names:
            directory = root_path / directory_name
            if directory.is_symlink():
                raise ValidationError(f"source contains a symlink directory: {directory}")
        for file_name in file_names:
            candidate = root_path / file_name
            if candidate.is_symlink():
                raise ValidationError(f"source contains a symlink file: {candidate}")
            if not candidate.is_file():
                raise ValidationError(f"source contains a non-regular file: {candidate}")
            files.append(candidate)
    return files


def build_export(
    source: Path,
    destination: Path,
    drain_receipt_path: Path,
    inventory_path: Path,
    logical_records_path: Path,
) -> dict[str, object]:
    """Build and atomically publish one immutable export directory."""

    source = require_absolute_path(str(source), "source")
    if not source.is_dir():
        raise ValidationError("source must be an existing directory")
    destination = require_absolute_path(str(destination), "destination", must_exist=False)
    if destination.exists() or destination.is_symlink():
        raise ValidationError(f"destination already exists: {destination}")
    if _paths_overlap(source, destination):
        raise ValidationError("source and destination must not contain one another")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    drain_receipt_path = require_absolute_path(str(drain_receipt_path), "drain_receipt")
    inventory_path = require_absolute_path(str(inventory_path), "inventory")
    logical_records_path = require_absolute_path(str(logical_records_path), "logical_records")
    drain = validate_drain_receipt(drain_receipt_path)
    inventory = load_inventory(inventory_path)
    logical_records = load_logical_records(logical_records_path)
    require_class_coverage(
        logical_records,
        inventory.required_logical_classes,
        "logical records",
    )

    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent))
    try:
        payload_root = staging / "payload"
        payload_root.mkdir(mode=0o700)
        file_records: list[dict[str, object]] = []
        data_class_counts: Counter[str] = Counter()
        total_bytes = 0
        for source_file in _source_files(source):
            relative = source_file.relative_to(source).as_posix()
            data_class = classify_path(relative, inventory)
            exported_file = payload_root / Path(relative)
            size, source_mode = _copy_regular_file(source_file, exported_file)
            file_records.append(
                {
                    "path": relative,
                    "data_class": data_class,
                    "size": size,
                    "source_mode": mode_string(source_mode),
                    "export_mode": mode_string(EXPORT_FILE_MODE),
                    "sha256": sha256_file(exported_file),
                }
            )
            data_class_counts[data_class] += 1
            total_bytes += size

        missing_data_classes = inventory.required_data_classes - set(data_class_counts)
        if missing_data_classes:
            raise ValidationError(
                f"source lacks required data classes: {sorted(missing_data_classes)}"
            )
        file_records.sort(key=lambda item: str(item["path"]))
        logical_dicts = [record.as_dict() for record in logical_records]
        logical_class_counts = Counter(record.record_class for record in logical_records)
        created_at = utc_now()
        manifest: dict[str, object] = {
            "schema_version": SCHEMA_VERSION,
            "manifest_type": EXPORT_MANIFEST_TYPE,
            "source_id": drain["source_id"],
            "authority_timestamp": drain["authority_timestamp"],
            "created_at": created_at,
            "drain_receipt_sha256": sha256_file(drain_receipt_path),
            "inventory_sha256": sha256_file(inventory_path),
            "logical_records_input_sha256": sha256_file(logical_records_path),
            "disposition_record_classes": sorted(inventory.disposition_record_classes),
            "files": file_records,
            "logical_records": logical_dicts,
            "summary": {
                "file_count": len(file_records),
                "total_bytes": total_bytes,
                "data_class_counts": dict(sorted(data_class_counts.items())),
                "logical_record_count": len(logical_records),
                "logical_class_counts": dict(sorted(logical_class_counts.items())),
            },
        }
        manifest_path = staging / "manifest.json"
        atomic_write_json(manifest_path, manifest, EXPORT_FILE_MODE)
        copy_receipt: dict[str, object] = {
            "schema_version": SCHEMA_VERSION,
            "receipt_type": COPY_RECEIPT_TYPE,
            "source_id": drain["source_id"],
            "created_at": created_at,
            "manifest_sha256": sha256_file(manifest_path),
            "payload_tree_sha256": payload_tree_hash(file_records),
            "drain_receipt_sha256": sha256_file(drain_receipt_path),
            "immutable_modes": True,
        }
        atomic_write_json(staging / "copy-receipt.json", copy_receipt, EXPORT_FILE_MODE)

        for root, directory_names, _file_names in os.walk(staging, topdown=False):
            for directory_name in directory_names:
                os.chmod(Path(root) / directory_name, EXPORT_DIRECTORY_MODE)
            os.chmod(root, EXPORT_DIRECTORY_MODE)
        staging.rename(destination)
        return copy_receipt
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Copy an explicitly drained memory root into a new immutable export"
    )
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--drain-receipt", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--logical-records", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; never chooses a source or destination implicitly."""

    args = _parser().parse_args(argv)
    try:
        receipt = build_export(
            args.source,
            args.destination,
            args.drain_receipt,
            args.inventory,
            args.logical_records,
        )
    except (OSError, ValidationError) as exc:
        print(f"export refused: {exc}", file=sys.stderr)
        return 2
    print(receipt["manifest_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
