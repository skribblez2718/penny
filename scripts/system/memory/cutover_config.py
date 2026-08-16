"""Strict caller-supplied configuration for MEM-05/MEM-06 tooling.

The contract intentionally has no endpoint, palace, evidence, journal, or state
path defaults.  Both authorities are independently validated hub configs.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .common import (
    ValidationError,
    ensure_owner_only,
    load_json_object,
    require_absolute_path,
    require_identifier,
    sha256_file,
)
from .hub_config import HubConfig, load_hub_config

CUTOVER_CONFIG_SCHEMA_VERSION = 1
MAX_APPROVED_CLIENTS = 64


@dataclass(frozen=True)
class OperationSpec:
    """Caller-declared mapping for one journaled write plane."""

    plane: str
    write_tool: str
    operation_id_argument: str
    resulting_ids_path: tuple[str, ...]
    resulting_ids_mode: str
    read_tool: str
    read_ids_argument: str
    read_ids_argument_mode: str
    read_items_path: tuple[str, ...]
    read_items_mode: str
    read_item_id_field: str
    read_projection_fields: tuple[str, ...]


@dataclass(frozen=True)
class CutoverConfig:
    """Validated static cutover contract for source, candidate, and clients."""

    config_path: Path
    config_sha256: str
    cutover_id: str
    source: HubConfig
    candidate: HubConfig
    state_path: Path
    journal_path: Path
    approval_ledger_path: Path
    control_lock_path: Path
    shadow_fixtures_path: Path
    canary_client_ids: tuple[str, ...]
    approved_client_ids: tuple[str, ...]
    no_fallback: bool
    post_ack_read_required: bool
    operation_specs: dict[str, OperationSpec]


def _identifier_list(raw: object, field: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw:
        raise ValidationError(f"{field} must be a non-empty list")
    values = tuple(
        require_identifier(value, f"{field}[{index}]") for index, value in enumerate(raw)
    )
    if len(set(values)) != len(values):
        raise ValidationError(f"{field} contains duplicates")
    if len(values) > MAX_APPROVED_CLIENTS:
        raise ValidationError(f"{field} exceeds the hard bound of {MAX_APPROVED_CLIENTS}")
    return values


def _json_path(raw: object, field: str, *, allow_root: bool = False) -> tuple[str, ...]:
    if not isinstance(raw, list) or (not raw and not allow_root):
        qualification = (
            "a JSON object path (empty selects the root)"
            if allow_root
            else "a non-empty JSON object path"
        )
        raise ValidationError(f"{field} must be {qualification}")
    return tuple(require_identifier(part, f"{field}[{index}]") for index, part in enumerate(raw))


def _mode(raw: object, field: str, allowed: frozenset[str]) -> str:
    if raw not in allowed:
        raise ValidationError(f"{field} must be one of {sorted(allowed)}")
    return str(raw)


def _operation_specs(raw: object) -> dict[str, OperationSpec]:
    if not isinstance(raw, dict) or not raw:
        raise ValidationError("operation_specs must be a non-empty object")
    specs: dict[str, OperationSpec] = {}
    required = {
        "write_tool",
        "operation_id_argument",
        "resulting_ids_path",
        "resulting_ids_mode",
        "read_tool",
        "read_ids_argument",
        "read_ids_argument_mode",
        "read_items_path",
        "read_items_mode",
        "read_item_id_field",
        "read_projection_fields",
    }
    for raw_plane, raw_spec in raw.items():
        plane = require_identifier(raw_plane, "operation_specs plane")
        if not isinstance(raw_spec, dict) or set(raw_spec) != required:
            raise ValidationError(f"operation_specs.{plane} has unknown or missing fields")
        projection = _json_path(
            raw_spec["read_projection_fields"],
            f"operation_specs.{plane}.read_projection_fields",
        )
        item_id = require_identifier(
            raw_spec["read_item_id_field"],
            f"operation_specs.{plane}.read_item_id_field",
        )
        if item_id not in projection:
            raise ValidationError(
                f"operation_specs.{plane}.read_projection_fields must include the ID field"
            )
        spec = OperationSpec(
            plane=plane,
            write_tool=require_identifier(
                raw_spec["write_tool"], f"operation_specs.{plane}.write_tool"
            ),
            operation_id_argument=require_identifier(
                raw_spec["operation_id_argument"],
                f"operation_specs.{plane}.operation_id_argument",
            ),
            resulting_ids_path=_json_path(
                raw_spec["resulting_ids_path"],
                f"operation_specs.{plane}.resulting_ids_path",
            ),
            resulting_ids_mode=_mode(
                raw_spec["resulting_ids_mode"],
                f"operation_specs.{plane}.resulting_ids_mode",
                frozenset({"list", "scalar"}),
            ),
            read_tool=require_identifier(
                raw_spec["read_tool"], f"operation_specs.{plane}.read_tool"
            ),
            read_ids_argument=require_identifier(
                raw_spec["read_ids_argument"],
                f"operation_specs.{plane}.read_ids_argument",
            ),
            read_ids_argument_mode=_mode(
                raw_spec["read_ids_argument_mode"],
                f"operation_specs.{plane}.read_ids_argument_mode",
                frozenset({"list", "scalar"}),
            ),
            read_items_path=_json_path(
                raw_spec["read_items_path"],
                f"operation_specs.{plane}.read_items_path",
                allow_root=True,
            ),
            read_items_mode=_mode(
                raw_spec["read_items_mode"],
                f"operation_specs.{plane}.read_items_mode",
                frozenset({"list", "single"}),
            ),
            read_item_id_field=item_id,
            read_projection_fields=projection,
        )
        if spec.write_tool == spec.read_tool:
            raise ValidationError(f"operation_specs.{plane} must use distinct read/write tools")
        specs[plane] = spec
    return specs


def _explicit_path(raw: object, field: str, *, must_exist: bool) -> Path:
    path = require_absolute_path(raw, field, must_exist=must_exist)
    if must_exist:
        ensure_owner_only(path, field)
    return path


def _load_distinct_hubs(document: dict[str, object]) -> tuple[HubConfig, HubConfig]:
    source_config_path = _explicit_path(document["source_config"], "source_config", must_exist=True)
    candidate_config_path = _explicit_path(
        document["candidate_config"], "candidate_config", must_exist=True
    )
    if source_config_path == candidate_config_path:
        raise ValidationError("source_config and candidate_config must be distinct")
    source = load_hub_config(source_config_path)
    candidate = load_hub_config(candidate_config_path)
    if source.endpoint == candidate.endpoint:
        raise ValidationError("source and candidate endpoints must be distinct")
    if source.data_roots["palace"] == candidate.data_roots["palace"]:
        raise ValidationError("source and candidate palace roots must be distinct")
    return source, candidate


def load_cutover_config(path: Path) -> CutoverConfig:
    """Load a strict, owner-only MEM-05/MEM-06 configuration."""

    config_path = require_absolute_path(str(path), "config")
    ensure_owner_only(config_path, "config")
    document = load_json_object(config_path)
    required = {
        "schema_version",
        "cutover_id",
        "source_config",
        "candidate_config",
        "state_path",
        "journal_path",
        "approval_ledger_path",
        "control_lock_path",
        "shadow_fixtures_path",
        "canary_client_ids",
        "approved_client_ids",
        "no_fallback",
        "post_ack_read_required",
        "operation_specs",
    }
    if set(document) != required:
        raise ValidationError("cutover config has unknown or missing fields")
    if document.get("schema_version") != CUTOVER_CONFIG_SCHEMA_VERSION:
        raise ValidationError(
            f"cutover config schema_version must be {CUTOVER_CONFIG_SCHEMA_VERSION}"
        )

    source, candidate = _load_distinct_hubs(document)

    state_path = _explicit_path(document["state_path"], "state_path", must_exist=False)
    journal_path = _explicit_path(document["journal_path"], "journal_path", must_exist=False)
    approval_ledger_path = _explicit_path(
        document["approval_ledger_path"], "approval_ledger_path", must_exist=False
    )
    control_lock_path = _explicit_path(
        document["control_lock_path"], "control_lock_path", must_exist=False
    )
    fixtures_path = _explicit_path(
        document["shadow_fixtures_path"], "shadow_fixtures_path", must_exist=True
    )
    if (
        len(
            {
                state_path,
                journal_path,
                approval_ledger_path,
                control_lock_path,
                fixtures_path,
                config_path,
            }
        )
        != 6
    ):
        raise ValidationError(
            "config, state, journal, approval ledger, control lock, and fixtures must be distinct"
        )

    approved = _identifier_list(document["approved_client_ids"], "approved_client_ids")
    canary = _identifier_list(document["canary_client_ids"], "canary_client_ids")
    if not set(canary).issubset(set(approved)):
        raise ValidationError("canary_client_ids must be a subset of approved_client_ids")
    if len(canary) >= len(approved) and len(approved) > 1:
        raise ValidationError("canary client set must be smaller than the approved expansion set")
    if document["no_fallback"] is not True:
        raise ValidationError("no_fallback must be true")
    if document["post_ack_read_required"] is not True:
        raise ValidationError("post_ack_read_required must be true")

    return CutoverConfig(
        config_path=config_path,
        config_sha256=sha256_file(config_path),
        cutover_id=require_identifier(document["cutover_id"], "cutover_id"),
        source=source,
        candidate=candidate,
        state_path=state_path,
        journal_path=journal_path,
        approval_ledger_path=approval_ledger_path,
        control_lock_path=control_lock_path,
        shadow_fixtures_path=fixtures_path,
        canary_client_ids=canary,
        approved_client_ids=approved,
        no_fallback=True,
        post_ack_read_required=True,
        operation_specs=_operation_specs(document["operation_specs"]),
    )
