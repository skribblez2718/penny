"""Schema validation shared by disposition manifest builder and verifier."""

from __future__ import annotations

from collections import Counter
from typing import Any

from .common import ValidationError, require_identifier, require_sha256, require_utc_timestamp
from .manifest_core import SCHEMA_VERSION

DISPOSITION_MANIFEST_TYPE = "memory-disposition"
DISPOSITION_DECISIONS_TYPE = "memory-disposition-decisions"
ALLOWED_STATUSES = frozenset({"hot", "legacy-archive", "duplicate/superseded", "quarantine"})
SAFE_DEFAULT_POLICY = "safe-default/quarantine-unreviewed-v1"
SAFE_DEFAULT_REASON = "No explicit hash-bound disposition decision was supplied"
SAFE_DEFAULT_DESTINATION = "quarantine"
REVERSIBILITY_BASIS = "reversible-from-immutable-export"
MAX_REASON_CHARACTERS = 4096


def require_reason(raw: object, field: str) -> str:
    """Validate a bounded human review rationale."""

    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_REASON_CHARACTERS:
        raise ValidationError(f"{field} must be 1..{MAX_REASON_CHARACTERS} characters")
    return raw.strip()


def validate_disposition_entry(
    raw: object,
    field: str,
    *,
    allow_pending_reviewer: bool = True,
) -> dict[str, Any]:
    """Strictly validate one hash-bound disposition entry."""

    required_fields = {
        "record_class",
        "record_id",
        "source_hash",
        "status",
        "reason",
        "destination",
        "reviewer",
        "policy",
        "reversible",
        "reversibility_basis",
        "approved",
    }
    if not isinstance(raw, dict) or set(raw) != required_fields:
        raise ValidationError(f"{field} has unknown or missing fields")
    record_class = require_identifier(raw["record_class"], f"{field}.record_class")
    record_id = require_identifier(raw["record_id"], f"{field}.record_id")
    source_hash = require_sha256(raw["source_hash"], f"{field}.source_hash")
    status = raw["status"]
    if status not in ALLOWED_STATUSES:
        raise ValidationError(f"{field}.status must be one of {sorted(ALLOWED_STATUSES)}")
    reason = require_reason(raw["reason"], f"{field}.reason")
    destination = require_identifier(raw["destination"], f"{field}.destination")
    reviewer_raw = raw["reviewer"]
    reviewer: str | None
    if reviewer_raw is None and allow_pending_reviewer:
        reviewer = None
    else:
        reviewer = require_identifier(reviewer_raw, f"{field}.reviewer")
    policy = require_identifier(raw["policy"], f"{field}.policy")
    reversible = raw["reversible"]
    approved = raw["approved"]
    if not isinstance(reversible, bool) or not isinstance(approved, bool):
        raise ValidationError(f"{field}.reversible and approved must be booleans")
    reversibility_basis = require_reason(raw["reversibility_basis"], f"{field}.reversibility_basis")
    if approved and reviewer is None:
        raise ValidationError(f"{field} cannot be approved without a reviewer")
    return {
        "record_class": record_class,
        "record_id": record_id,
        "source_hash": source_hash,
        "status": status,
        "reason": reason,
        "destination": destination,
        "reviewer": reviewer,
        "policy": policy,
        "reversible": reversible,
        "reversibility_basis": reversibility_basis,
        "approved": approved,
    }


def expected_disposition_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute the canonical coverage/review/status summary."""

    return {
        "record_count": len(records),
        "status_counts": dict(sorted(Counter(record["status"] for record in records).items())),
        "class_counts": dict(sorted(Counter(record["record_class"] for record in records).items())),
        "approved_count": sum(1 for record in records if record["approved"]),
        "pending_count": sum(1 for record in records if not record["approved"]),
        "full_candidate_count": len(records),
        "curated_candidate_count": sum(1 for record in records if record["status"] == "hot"),
    }


def validate_disposition_manifest(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate a complete disposition document independent of its source manifest."""

    expected_fields = {
        "schema_version",
        "manifest_type",
        "created_at",
        "source_id",
        "source_manifest_sha256",
        "source_copy_receipt_sha256",
        "records",
        "full_candidate",
        "curated_candidate",
        "summary",
    }
    if set(document) != expected_fields:
        raise ValidationError("disposition manifest has unknown or missing fields")
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ValidationError(f"disposition schema_version must be {SCHEMA_VERSION}")
    if document.get("manifest_type") != DISPOSITION_MANIFEST_TYPE:
        raise ValidationError(f"manifest_type must be {DISPOSITION_MANIFEST_TYPE}")
    require_utc_timestamp(document.get("created_at"), "disposition.created_at")
    require_identifier(document.get("source_id"), "disposition.source_id")
    require_sha256(document.get("source_manifest_sha256"), "source_manifest_sha256")
    require_sha256(document.get("source_copy_receipt_sha256"), "source_copy_receipt_sha256")
    raw_records = document.get("records")
    if not isinstance(raw_records, list):
        raise ValidationError("disposition.records must be a list")
    records = [
        validate_disposition_entry(raw, f"records[{index}]")
        for index, raw in enumerate(raw_records)
    ]
    keys = [(record["record_class"], record["record_id"]) for record in records]
    if len(set(keys)) != len(keys):
        raise ValidationError("disposition contains duplicate records")
    if records != sorted(records, key=lambda item: (item["record_class"], item["record_id"])):
        raise ValidationError("disposition records are not canonically sorted")
    if document.get("summary") != expected_disposition_summary(records):
        raise ValidationError("disposition summary does not match records")
    return records
