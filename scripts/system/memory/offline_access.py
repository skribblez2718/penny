"""Fail-closed authorization for copied/offline memory-byte access."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .common import (
    ValidationError,
    ensure_owner_only,
    load_json_object,
    require_identifier,
    require_utc_timestamp,
)
from .hub_config import load_hub_config

OFFLINE_RECEIPT_SCHEMA_VERSION = 1
OFFLINE_RECEIPT_TYPE = "memory-offline-access"
OFFLINE_TARGET_KIND = "copied-offline"
REQUIRED_OFFLINE_CHECKS = frozenset(
    {"drain_complete", "hub_stopped", "peer_processes_stopped", "target_is_copy"}
)
LIVE_PATH_ENVIRONMENT_NAMES = (
    "MEMPALACE_PALACE_PATH",
    "MEMPAL_PALACE_PATH",
    "MEMPALACE_PATH",
)


@dataclass(frozen=True)
class OfflineAuthorization:
    """Validated receipt binding byte access to one explicit copied target."""

    target: Path
    receipt_path: Path
    source_id: str
    approved_by: str
    authority_timestamp: str


def _absolute_directory(path: Path, field: str) -> Path:
    if not path.is_absolute():
        raise ValidationError(f"{field} must be an explicit absolute path")
    if path.is_symlink():
        raise ValidationError(f"{field} must not be a symlink")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValidationError(f"cannot resolve {field}: {exc}") from exc
    if not resolved.is_dir():
        raise ValidationError(f"{field} must be a directory")
    return resolved


def _configured_live_paths(environment: Mapping[str, str]) -> set[Path]:
    paths: set[Path] = set()
    for name in LIVE_PATH_ENVIRONMENT_NAMES:
        raw = environment.get(name, "").strip()
        if raw and Path(raw).is_absolute():
            paths.add(Path(raw).resolve(strict=False))

    raw_config = environment.get("PENNY_MEMORY_HUB_CONFIG", "").strip()
    if raw_config:
        config_path = Path(raw_config)
        if not config_path.is_absolute():
            raise ValidationError("PENNY_MEMORY_HUB_CONFIG must be absolute when set")
        config = load_hub_config(config_path)
        paths.add(config.data_roots["palace"])
    return paths


def _validate_receipt(receipt_path: Path, target: Path) -> tuple[Path, dict[str, object]]:
    if not receipt_path.is_absolute():
        raise ValidationError("offline receipt must be an explicit absolute path")
    if receipt_path.is_symlink():
        raise ValidationError("offline receipt must not be a symlink")
    try:
        receipt = receipt_path.resolve(strict=True)
    except OSError as exc:
        raise ValidationError(f"cannot resolve offline receipt: {exc}") from exc
    ensure_owner_only(receipt, "offline receipt")
    document = load_json_object(receipt)
    expected_fields = {
        "schema_version",
        "receipt_type",
        "target_kind",
        "target_path",
        "source_id",
        "authority_timestamp",
        "approved_by",
        "checks",
    }
    if set(document) != expected_fields:
        raise ValidationError("offline receipt has unknown or missing fields")
    if document.get("schema_version") != OFFLINE_RECEIPT_SCHEMA_VERSION:
        raise ValidationError(
            f"offline receipt schema_version must be {OFFLINE_RECEIPT_SCHEMA_VERSION}"
        )
    if document.get("receipt_type") != OFFLINE_RECEIPT_TYPE:
        raise ValidationError(f"offline receipt_type must be {OFFLINE_RECEIPT_TYPE}")
    if document.get("target_kind") != OFFLINE_TARGET_KIND:
        raise ValidationError(f"offline target_kind must be {OFFLINE_TARGET_KIND}")
    _validate_receipt_target(document.get("target_path"), target)
    _validate_checks(document.get("checks"))
    return receipt, document


def _validate_receipt_target(raw_target: object, target: Path) -> None:
    if not isinstance(raw_target, str) or not Path(raw_target).is_absolute():
        raise ValidationError("offline receipt target_path must be absolute")
    if Path(raw_target).resolve(strict=True) != target:
        raise ValidationError("offline receipt target_path does not match the supplied target")


def _validate_checks(raw_checks: object) -> None:
    if not isinstance(raw_checks, dict) or set(raw_checks) != REQUIRED_OFFLINE_CHECKS:
        raise ValidationError(
            f"offline checks must contain exactly {sorted(REQUIRED_OFFLINE_CHECKS)}"
        )
    unsafe = sorted(name for name, value in raw_checks.items() if value is not True)
    if unsafe:
        raise ValidationError(f"offline receipt has unsafe checks: {unsafe}")


def authorize_offline_target(
    target_path: Path,
    receipt_path: Path,
    *,
    environment: Mapping[str, str] | None = None,
) -> OfflineAuthorization:
    """Authorize raw-byte access only to a receipt-bound copied target.

    The receipt is an operator assertion made after draining every writer,
    stopping the supervised hub, stopping all peer clients, and copying the
    source.  This function validates that assertion's strict schema and rejects
    all configured live paths.  It does not infer or default any target.
    """

    environment = environment if environment is not None else os.environ
    target = _absolute_directory(target_path, "offline target")
    if target in _configured_live_paths(environment):
        raise ValidationError("offline target resolves to a configured live palace path")

    receipt, document = _validate_receipt(receipt_path, target)
    return OfflineAuthorization(
        target=target,
        receipt_path=receipt,
        source_id=require_identifier(document.get("source_id"), "offline source_id"),
        approved_by=require_identifier(document.get("approved_by"), "offline approved_by"),
        authority_timestamp=require_utc_timestamp(
            document.get("authority_timestamp"), "offline authority_timestamp"
        ),
    )
