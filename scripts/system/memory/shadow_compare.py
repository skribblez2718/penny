"""Read-only MEM-05 source/candidate shadow comparison tooling."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, cast

from .admin_client import MemoryAdminClient
from .common import (
    ValidationError,
    atomic_write_json,
    canonical_json_bytes,
    ensure_owner_only,
    load_json_object,
    require_absolute_path,
    require_identifier,
    sha256_bytes,
    sha256_file,
    utc_now,
)
from .cutover_config import CutoverConfig
from .cutover_evidence import (
    EVIDENCE_SCHEMA_VERSION,
    SHADOW_RECEIPT_TYPE,
    validate_authority_receipt,
)

SHADOW_FIXTURE_TYPE = "memory-shadow-fixtures"
FORBIDDEN_TOOL_TOKENS = ("add", "write", "delete", "remove", "repair", "migrate", "restore")


@dataclass(frozen=True)
class ShadowTolerance:
    """Explicit per-fixture ranking and latency tolerance."""

    max_rank_displacement: int
    candidate_latency_ms_max: float
    candidate_over_source_ms_max: float


@dataclass(frozen=True)
class ShadowFixture:
    """One read request plus exact item extraction contract."""

    fixture_id: str
    tool: str
    arguments: dict[str, Any]
    items_path: tuple[str, ...]
    id_field: str
    content_field: str
    tolerance: ShadowTolerance


def _path(raw: object, field: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw:
        raise ValidationError(f"{field} must be a non-empty object path")
    return tuple(require_identifier(part, f"{field}[{index}]") for index, part in enumerate(raw))


def _non_negative_number(raw: object, field: str, *, positive: bool = False) -> float:
    if not isinstance(raw, (int, float)) or isinstance(raw, bool):
        raise ValidationError(f"{field} must be numeric")
    value = float(raw)
    if value < 0 or (positive and value <= 0):
        qualifier = "positive" if positive else "non-negative"
        raise ValidationError(f"{field} must be {qualifier}")
    return value


def _parse_fixture(raw: object, index: int, read_tools: set[str]) -> ShadowFixture:
    fixture_fields = {"fixture_id", "tool", "arguments", "extraction", "tolerances"}
    if not isinstance(raw, dict) or set(raw) != fixture_fields:
        raise ValidationError(f"fixtures[{index}] has unknown or missing fields")
    fixture_id = require_identifier(raw["fixture_id"], f"fixtures[{index}].fixture_id")
    tool = require_identifier(raw["tool"], f"fixtures[{index}].tool")
    if tool not in read_tools:
        raise ValidationError(f"fixtures[{index}].tool is not declared read-only")
    arguments = raw["arguments"]
    if not isinstance(arguments, dict):
        raise ValidationError(f"fixtures[{index}].arguments must be an object")
    extraction = raw["extraction"]
    if not isinstance(extraction, dict) or set(extraction) != {
        "items_path",
        "id_field",
        "content_field",
    }:
        raise ValidationError(f"fixtures[{index}].extraction is invalid")
    tolerances = raw["tolerances"]
    if not isinstance(tolerances, dict) or set(tolerances) != {
        "max_rank_displacement",
        "candidate_latency_ms_max",
        "candidate_over_source_ms_max",
    }:
        raise ValidationError(f"fixtures[{index}].tolerances is invalid")
    displacement = tolerances["max_rank_displacement"]
    if not isinstance(displacement, int) or isinstance(displacement, bool) or displacement < 0:
        raise ValidationError("max_rank_displacement must be a non-negative integer")
    return ShadowFixture(
        fixture_id=fixture_id,
        tool=tool,
        arguments=cast(dict[str, Any], arguments),
        items_path=_path(extraction["items_path"], "items_path"),
        id_field=require_identifier(extraction["id_field"], "id_field"),
        content_field=require_identifier(extraction["content_field"], "content_field"),
        tolerance=ShadowTolerance(
            max_rank_displacement=displacement,
            candidate_latency_ms_max=_non_negative_number(
                tolerances["candidate_latency_ms_max"],
                "candidate_latency_ms_max",
                positive=True,
            ),
            candidate_over_source_ms_max=_non_negative_number(
                tolerances["candidate_over_source_ms_max"],
                "candidate_over_source_ms_max",
            ),
        ),
    )


def _validated_read_tools(document: Mapping[str, Any], config: CutoverConfig) -> set[str]:
    raw_tools = document.get("read_tools")
    if not isinstance(raw_tools, list) or not raw_tools:
        raise ValidationError("shadow read_tools must be a non-empty list")
    read_tools = {
        require_identifier(value, f"read_tools[{index}]") for index, value in enumerate(raw_tools)
    }
    if len(read_tools) != len(raw_tools):
        raise ValidationError("shadow read_tools contains duplicates")
    configured_write_tools = {spec.write_tool for spec in config.operation_specs.values()}
    if read_tools & configured_write_tools:
        raise ValidationError("shadow read_tools overlaps configured write tools")
    for tool in read_tools:
        lowered_parts = tool.lower().replace("-", "_").split("_")
        if any(token in lowered_parts for token in FORBIDDEN_TOOL_TOKENS):
            raise ValidationError(f"shadow tool is not read-only: {tool}")
    return read_tools


def load_shadow_fixtures(path: Path, config: CutoverConfig) -> tuple[ShadowFixture, ...]:
    """Load strict read-only fixtures with no inferred tolerance."""

    fixture_path = require_absolute_path(str(path), "shadow_fixtures")
    ensure_owner_only(fixture_path, "shadow_fixtures")
    document = load_json_object(fixture_path)
    if set(document) != {"schema_version", "document_type", "read_tools", "fixtures"}:
        raise ValidationError("shadow fixtures have unknown or missing fields")
    if document.get("schema_version") != EVIDENCE_SCHEMA_VERSION:
        raise ValidationError(f"shadow fixtures schema_version must be {EVIDENCE_SCHEMA_VERSION}")
    if document.get("document_type") != SHADOW_FIXTURE_TYPE:
        raise ValidationError(f"shadow fixture document_type must be {SHADOW_FIXTURE_TYPE}")
    read_tools = _validated_read_tools(document, config)
    raw_fixtures = document.get("fixtures")
    if not isinstance(raw_fixtures, list) or not raw_fixtures:
        raise ValidationError("shadow fixtures must be a non-empty list")
    fixtures = [_parse_fixture(raw, index, read_tools) for index, raw in enumerate(raw_fixtures)]
    fixture_ids = [fixture.fixture_id for fixture in fixtures]
    if len(set(fixture_ids)) != len(fixture_ids):
        raise ValidationError("shadow fixture IDs must be unique")
    return tuple(fixtures)


def _at_path(payload: Mapping[str, Any], path: tuple[str, ...], fixture_id: str) -> object:
    current: object = payload
    for part in path:
        if not isinstance(current, dict) or part not in current:
            raise ValidationError(f"shadow fixture {fixture_id} response lacks items_path")
        current = current[part]
    return current


def _normalize(
    fixture: ShadowFixture, payload: Mapping[str, Any]
) -> tuple[tuple[str, ...], dict[str, str]]:
    raw_items = _at_path(payload, fixture.items_path, fixture.fixture_id)
    if not isinstance(raw_items, list):
        raise ValidationError(f"shadow fixture {fixture.fixture_id} items_path is not a list")
    ranked_ids: list[str] = []
    contents: dict[str, str] = {}
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            raise ValidationError(
                f"shadow fixture {fixture.fixture_id} item {index} is not an object"
            )
        item = cast(dict[str, Any], raw_item)
        item_id = require_identifier(
            item.get(fixture.id_field), f"{fixture.fixture_id}.items[{index}].id"
        )
        if item_id in contents:
            raise ValidationError(f"shadow fixture {fixture.fixture_id} returned duplicate IDs")
        if fixture.content_field not in item:
            raise ValidationError(f"shadow fixture {fixture.fixture_id} item lacks exact content")
        ranked_ids.append(item_id)
        contents[item_id] = sha256_bytes(canonical_json_bytes(item[fixture.content_field]))
    return tuple(ranked_ids), contents


def _timed_call(
    client: MemoryAdminClient,
    fixture: ShadowFixture,
    clock: Callable[[], float],
) -> tuple[dict[str, Any], float]:
    started = clock()
    payload = client.call_tool(fixture.tool, fixture.arguments).payload
    elapsed_ms = max(0.0, (clock() - started) * 1000.0)
    return payload, elapsed_ms


def run_shadow_comparison(
    config: CutoverConfig,
    source_authority_receipt: Path,
    output: Path,
    *,
    source_client: MemoryAdminClient | None = None,
    candidate_client: MemoryAdminClient | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> dict[str, Any]:
    """Compare source/candidate reads while retaining source sole-write authority."""

    authority_path = require_absolute_path(str(source_authority_receipt), "source_authority")
    validate_authority_receipt(authority_path, config, "source")
    destination = require_absolute_path(str(output), "output", must_exist=False)
    fixtures = load_shadow_fixtures(config.shadow_fixtures_path, config)
    source = source_client or MemoryAdminClient.from_hub_config(config.source)
    candidate = candidate_client or MemoryAdminClient.from_hub_config(config.candidate)
    comparisons: list[dict[str, Any]] = []
    mismatch_count = 0

    for fixture in fixtures:
        source_payload, source_ms = _timed_call(source, fixture, clock)
        candidate_payload, candidate_ms = _timed_call(candidate, fixture, clock)
        source_ids, source_contents = _normalize(fixture, source_payload)
        candidate_ids, candidate_contents = _normalize(fixture, candidate_payload)
        id_set_equal = set(source_ids) == set(candidate_ids)
        content_equal = id_set_equal and source_contents == candidate_contents
        displacements = {
            item_id: abs(source_ids.index(item_id) - candidate_ids.index(item_id))
            for item_id in source_ids
            if item_id in candidate_contents
        }
        max_displacement = max(displacements.values(), default=0)
        ranking_within_tolerance = id_set_equal and (
            max_displacement <= fixture.tolerance.max_rank_displacement
        )
        latency_within_tolerance = (
            candidate_ms <= fixture.tolerance.candidate_latency_ms_max
            and candidate_ms - source_ms <= fixture.tolerance.candidate_over_source_ms_max
        )
        passed = (
            id_set_equal and content_equal and ranking_within_tolerance and latency_within_tolerance
        )
        if not passed:
            mismatch_count += 1
        comparisons.append(
            {
                "fixture_id": fixture.fixture_id,
                "source_ranked_ids": list(source_ids),
                "candidate_ranked_ids": list(candidate_ids),
                "source_content_sha256": source_contents,
                "candidate_content_sha256": candidate_contents,
                "id_set_equal": id_set_equal,
                "content_equal": content_equal,
                "max_rank_displacement": max_displacement,
                "ranking_within_tolerance": ranking_within_tolerance,
                "source_latency_ms": round(source_ms, 6),
                "candidate_latency_ms": round(candidate_ms, 6),
                "latency_within_tolerance": latency_within_tolerance,
                "tolerances": {
                    "max_rank_displacement": fixture.tolerance.max_rank_displacement,
                    "candidate_latency_ms_max": fixture.tolerance.candidate_latency_ms_max,
                    "candidate_over_source_ms_max": fixture.tolerance.candidate_over_source_ms_max,
                },
                "passed": passed,
            }
        )

    receipt: dict[str, Any] = {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "receipt_type": SHADOW_RECEIPT_TYPE,
        "cutover_id": config.cutover_id,
        "created_at": utc_now(),
        "cutover_config_sha256": config.config_sha256,
        "source_config_sha256": config.source.config_sha256,
        "candidate_config_sha256": config.candidate.config_sha256,
        "source_authority_receipt_sha256": sha256_file(authority_path),
        "fixtures_sha256": sha256_file(config.shadow_fixtures_path),
        "source_sole_writer": True,
        "candidate_write_count": 0,
        "comparison_count": len(comparisons),
        "mismatch_count": mismatch_count,
        "comparisons": comparisons,
        "passed": mismatch_count == 0,
    }
    atomic_write_json(destination, receipt)
    return receipt
