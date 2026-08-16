"""Canonical schemas and validation for immutable memory-copy manifests."""

from __future__ import annotations

import fnmatch
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .common import (
    ValidationError,
    canonical_json_bytes,
    load_json_object,
    require_identifier,
    require_sha256,
    require_utc_timestamp,
    sha256_bytes,
    sha256_file,
    validate_relative_path,
)

SCHEMA_VERSION = 1
EXPORT_MANIFEST_TYPE = "immutable-memory-export"
COPY_RECEIPT_TYPE = "immutable-memory-copy"
DRAIN_RECEIPT_TYPE = "memory-drain"
REQUIRED_DRAIN_CHECKS = frozenset({"writers", "raw_clients", "locks", "leases", "wal_safe"})


@dataclass(frozen=True)
class PathRule:
    """Map one portable glob to a caller-defined memory data class."""

    pattern: str
    data_class: str


@dataclass(frozen=True)
class LogicalRecord:
    """One hash-bound logical record independent of physical backend bytes."""

    record_class: str
    record_id: str
    logical_hash: str

    @property
    def key(self) -> tuple[str, str]:
        """Return the stable reconciliation key."""

        return (self.record_class, self.record_id)

    def as_dict(self) -> dict[str, str]:
        """Serialize this record into canonical manifest form."""

        return {
            "record_class": self.record_class,
            "record_id": self.record_id,
            "logical_hash": self.logical_hash,
        }


@dataclass(frozen=True)
class Inventory:
    """Caller-supplied classification contract for a source copy."""

    rules: tuple[PathRule, ...]
    required_data_classes: frozenset[str]
    required_logical_classes: frozenset[str]
    disposition_record_classes: frozenset[str]


def _require_schema(document: dict[str, Any], document_type: str) -> None:
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ValidationError(f"{document_type} schema_version must be {SCHEMA_VERSION}")


def _require_string_list(raw: object, field: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(raw, list) or (not raw and not allow_empty):
        raise ValidationError(f"{field} must be a non-empty list")
    result: list[str] = []
    for index, value in enumerate(raw):
        result.append(require_identifier(value, f"{field}[{index}]"))
    if len(set(result)) != len(result):
        raise ValidationError(f"{field} contains duplicates")
    return result


def load_inventory(path: Path) -> Inventory:
    """Load and strictly validate a path/logical classification inventory."""

    document = load_json_object(path)
    _require_schema(document, "inventory")
    allowed = {
        "schema_version",
        "path_rules",
        "required_data_classes",
        "required_logical_classes",
        "disposition_record_classes",
    }
    unknown = set(document) - allowed
    if unknown:
        raise ValidationError(f"inventory contains unknown fields: {sorted(unknown)}")

    raw_rules = document.get("path_rules")
    if not isinstance(raw_rules, list) or not raw_rules:
        raise ValidationError("inventory.path_rules must be a non-empty list")
    rules: list[PathRule] = []
    for index, raw_rule in enumerate(raw_rules):
        if not isinstance(raw_rule, dict) or set(raw_rule) != {"pattern", "data_class"}:
            raise ValidationError(f"path_rules[{index}] must contain pattern and data_class")
        pattern = raw_rule["pattern"]
        if (
            not isinstance(pattern, str)
            or not pattern
            or pattern.startswith("/")
            or "\\" in pattern
            or ".." in Path(pattern).parts
        ):
            raise ValidationError(f"path_rules[{index}].pattern is unsafe")
        data_class = require_identifier(raw_rule["data_class"], f"path_rules[{index}].data_class")
        rules.append(PathRule(pattern=pattern, data_class=data_class))

    required_data = frozenset(
        _require_string_list(document.get("required_data_classes"), "required_data_classes")
    )
    required_logical = frozenset(
        _require_string_list(document.get("required_logical_classes"), "required_logical_classes")
    )
    disposition_classes = frozenset(
        _require_string_list(
            document.get("disposition_record_classes"),
            "disposition_record_classes",
        )
    )
    rule_classes = {rule.data_class for rule in rules}
    missing_rule_classes = required_data - rule_classes
    if missing_rule_classes:
        raise ValidationError(
            f"required data classes have no classification rule: {sorted(missing_rule_classes)}"
        )
    if not disposition_classes.issubset(required_logical):
        raise ValidationError("disposition classes must be required logical classes")
    return Inventory(
        rules=tuple(rules),
        required_data_classes=required_data,
        required_logical_classes=required_logical,
        disposition_record_classes=disposition_classes,
    )


def classify_path(relative_path: str, inventory: Inventory) -> str:
    """Classify a path and reject ambiguous or unclassified input."""

    matches = [
        rule.data_class
        for rule in inventory.rules
        if fnmatch.fnmatchcase(relative_path, rule.pattern)
    ]
    if not matches:
        raise ValidationError(f"source file is not classified by inventory: {relative_path}")
    if len(matches) != 1:
        raise ValidationError(f"source file matches multiple classification rules: {relative_path}")
    return matches[0]


def load_logical_records(path: Path) -> list[LogicalRecord]:
    """Hash canonical logical values from a caller-produced logical record document."""

    document = load_json_object(path)
    _require_schema(document, "logical records")
    if set(document) != {"schema_version", "records"}:
        raise ValidationError("logical records document has unknown or missing fields")
    raw_records = document.get("records")
    if not isinstance(raw_records, list):
        raise ValidationError("logical records must contain a records list")

    records: list[LogicalRecord] = []
    seen: set[tuple[str, str]] = set()
    for index, raw_record in enumerate(raw_records):
        if not isinstance(raw_record, dict) or set(raw_record) != {
            "record_class",
            "record_id",
            "value",
        }:
            raise ValidationError(
                f"records[{index}] must contain record_class, record_id, and value"
            )
        record = LogicalRecord(
            record_class=require_identifier(
                raw_record["record_class"], f"records[{index}].record_class"
            ),
            record_id=require_identifier(raw_record["record_id"], f"records[{index}].record_id"),
            logical_hash=sha256_bytes(canonical_json_bytes(raw_record["value"])),
        )
        if record.key in seen:
            raise ValidationError(f"duplicate logical record: {record.key}")
        seen.add(record.key)
        records.append(record)
    return sorted(records, key=lambda item: item.key)


def validate_drain_receipt(path: Path) -> dict[str, Any]:
    """Require an approved receipt proving every writer/lease/WAL check is safe."""

    document = load_json_object(path)
    _require_schema(document, "drain receipt")
    if document.get("receipt_type") != DRAIN_RECEIPT_TYPE:
        raise ValidationError(f"drain receipt_type must be {DRAIN_RECEIPT_TYPE}")
    source_id = require_identifier(document.get("source_id"), "drain.source_id")
    authority_timestamp = require_utc_timestamp(
        document.get("authority_timestamp"), "drain.authority_timestamp"
    )
    approved_by = require_identifier(document.get("approved_by"), "drain.approved_by")
    checks = document.get("checks")
    if not isinstance(checks, dict) or set(checks) != REQUIRED_DRAIN_CHECKS:
        raise ValidationError(f"drain.checks must contain exactly {sorted(REQUIRED_DRAIN_CHECKS)}")
    failed = sorted(name for name, value in checks.items() if value is not True)
    if failed:
        raise ValidationError(f"drain receipt has unsafe checks: {failed}")
    return {
        "source_id": source_id,
        "authority_timestamp": authority_timestamp,
        "approved_by": approved_by,
    }


def logical_records_from_manifest(document: dict[str, Any]) -> list[LogicalRecord]:
    """Validate and return logical records from an export manifest."""

    raw_records = document.get("logical_records")
    if not isinstance(raw_records, list):
        raise ValidationError("manifest.logical_records must be a list")
    records: list[LogicalRecord] = []
    seen: set[tuple[str, str]] = set()
    for index, raw_record in enumerate(raw_records):
        if not isinstance(raw_record, dict) or set(raw_record) != {
            "record_class",
            "record_id",
            "logical_hash",
        }:
            raise ValidationError(f"manifest.logical_records[{index}] has invalid fields")
        record = LogicalRecord(
            record_class=require_identifier(
                raw_record["record_class"], f"logical_records[{index}].record_class"
            ),
            record_id=require_identifier(
                raw_record["record_id"], f"logical_records[{index}].record_id"
            ),
            logical_hash=require_sha256(
                raw_record["logical_hash"], f"logical_records[{index}].logical_hash"
            ),
        )
        if record.key in seen:
            raise ValidationError(f"duplicate logical record in manifest: {record.key}")
        seen.add(record.key)
        records.append(record)
    return records


def _validate_manifest_files(files: list[Any]) -> tuple[Counter[str], int]:
    seen_paths: set[str] = set()
    data_classes: Counter[str] = Counter()
    total_bytes = 0
    required_fields = {
        "path",
        "data_class",
        "size",
        "source_mode",
        "export_mode",
        "sha256",
    }
    for index, raw_file in enumerate(files):
        if not isinstance(raw_file, dict) or set(raw_file) != required_fields:
            raise ValidationError(f"manifest.files[{index}] has invalid fields")
        relative = validate_relative_path(raw_file["path"], f"files[{index}].path")
        if relative in seen_paths:
            raise ValidationError(f"duplicate manifest file path: {relative}")
        seen_paths.add(relative)
        data_class = require_identifier(raw_file["data_class"], f"files[{index}].data_class")
        size = raw_file["size"]
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValidationError(f"files[{index}].size must be a non-negative integer")
        for mode_field in ("source_mode", "export_mode"):
            mode = raw_file[mode_field]
            valid_mode = (
                isinstance(mode, str)
                and len(mode) == 4
                and all(character in "01234567" for character in mode)
            )
            if not valid_mode:
                raise ValidationError(f"files[{index}].{mode_field} must be four octal digits")
        require_sha256(raw_file["sha256"], f"files[{index}].sha256")
        data_classes[data_class] += 1
        total_bytes += size
    return data_classes, total_bytes


def validate_export_manifest(path: Path) -> dict[str, Any]:
    """Validate the structure and canonical summary of an export manifest."""

    document = load_json_object(path)
    expected_fields = {
        "schema_version",
        "manifest_type",
        "source_id",
        "authority_timestamp",
        "created_at",
        "drain_receipt_sha256",
        "inventory_sha256",
        "logical_records_input_sha256",
        "disposition_record_classes",
        "files",
        "logical_records",
        "summary",
    }
    if set(document) != expected_fields:
        raise ValidationError("export manifest has unknown or missing fields")
    _require_schema(document, "export manifest")
    if document.get("manifest_type") != EXPORT_MANIFEST_TYPE:
        raise ValidationError(f"manifest_type must be {EXPORT_MANIFEST_TYPE}")
    require_identifier(document.get("source_id"), "manifest.source_id")
    require_utc_timestamp(document.get("authority_timestamp"), "manifest.authority_timestamp")
    require_utc_timestamp(document.get("created_at"), "manifest.created_at")
    require_sha256(document.get("drain_receipt_sha256"), "manifest.drain_receipt_sha256")
    require_sha256(document.get("inventory_sha256"), "manifest.inventory_sha256")
    require_sha256(
        document.get("logical_records_input_sha256"), "manifest.logical_records_input_sha256"
    )
    disposition_classes = _require_string_list(
        document.get("disposition_record_classes"),
        "manifest.disposition_record_classes",
    )
    logical_records = logical_records_from_manifest(document)
    files = document.get("files")
    if not isinstance(files, list):
        raise ValidationError("manifest.files must be a list")
    data_classes, total_bytes = _validate_manifest_files(files)
    expected_summary = {
        "file_count": len(files),
        "total_bytes": total_bytes,
        "data_class_counts": dict(sorted(data_classes.items())),
        "logical_record_count": len(logical_records),
        "logical_class_counts": dict(
            sorted(Counter(record.record_class for record in logical_records).items())
        ),
    }
    if document.get("summary") != expected_summary:
        raise ValidationError("manifest.summary does not match manifest contents")
    if not set(disposition_classes).issubset({record.record_class for record in logical_records}):
        raise ValidationError("manifest disposition classes lack logical records")
    return document


def validate_copy_receipt(
    receipt_path: Path,
    manifest_path: Path,
    manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate that an immutable-copy receipt hash-binds one manifest."""

    document = load_json_object(receipt_path)
    _require_schema(document, "copy receipt")
    if document.get("receipt_type") != COPY_RECEIPT_TYPE:
        raise ValidationError(f"copy receipt_type must be {COPY_RECEIPT_TYPE}")
    active_manifest = manifest if manifest is not None else validate_export_manifest(manifest_path)
    if document.get("source_id") != active_manifest.get("source_id"):
        raise ValidationError("copy receipt source_id does not match manifest")
    if require_sha256(document.get("manifest_sha256"), "copy.manifest_sha256") != sha256_file(
        manifest_path
    ):
        raise ValidationError("copy receipt manifest hash mismatch")
    if document.get("payload_tree_sha256") != payload_tree_hash(active_manifest.get("files")):
        raise ValidationError("copy receipt payload tree hash mismatch")
    if document.get("drain_receipt_sha256") != active_manifest.get("drain_receipt_sha256"):
        raise ValidationError("copy receipt drain hash mismatch")
    if document.get("immutable_modes") is not True:
        raise ValidationError("copy receipt does not attest immutable modes")
    require_utc_timestamp(document.get("created_at"), "copy.created_at")
    return document


def payload_tree_hash(raw_files: object) -> str:
    """Hash canonical physical file records without relying on native index bytes."""

    if not isinstance(raw_files, list):
        raise ValidationError("files must be a list before computing payload tree hash")
    return sha256_bytes(canonical_json_bytes(sorted(raw_files, key=lambda item: item["path"])))


def require_class_coverage(
    records: Iterable[LogicalRecord], required_classes: frozenset[str], field: str
) -> None:
    """Require at least one logical record for every caller-declared class."""

    present = {record.record_class for record in records}
    missing = required_classes - present
    if missing:
        raise ValidationError(f"{field} missing required classes: {sorted(missing)}")
