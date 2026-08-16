"""Export exact logical memory records through the authenticated HTTP hub.

This admin-only utility is intentionally separate from model-visible memory
 tools. It reads drawer/KG state through the supported hub API and reads archive
and physical-sidecar metadata only from an explicit copied palace root. It never
opens ChromaDB or a MemPalace backend directly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from .admin_client import AdminClientError, MemoryAdminClient
from .common import ValidationError, atomic_write_json, canonical_json_bytes, require_absolute_path

SCHEMA_VERSION = 1
MAX_PAGE_SIZE = 1_000
MAX_WORKERS = 32


def _record(record_class: str, record_id: str, value: object) -> dict[str, object]:
    return {"record_class": record_class, "record_id": record_id, "value": value}


def _digest_id(prefix: str, value: object) -> str:
    digest = hashlib.sha256(canonical_json_bytes(value)).hexdigest()
    return f"{prefix}-{digest}"


def _require_mapping(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{field} must be an object")
    return value


def _require_list(value: object, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValidationError(f"{field} must be a list")
    return value


def _list_drawers(client: MemoryAdminClient) -> list[dict[str, Any]]:
    offset = 0
    expected_total: int | None = None
    drawers: list[dict[str, Any]] = []
    seen: set[str] = set()
    while expected_total is None or offset < expected_total:
        payload = client.call_tool(
            "mempalace_list_drawers", {"limit": MAX_PAGE_SIZE, "offset": offset}
        ).payload
        raw_total = payload.get("total")
        if not isinstance(raw_total, int) or isinstance(raw_total, bool) or raw_total < 0:
            raise ValidationError("list_drawers returned an invalid total")
        if expected_total is None:
            expected_total = raw_total
        elif raw_total != expected_total:
            raise ValidationError("drawer total changed during logical export")
        page = _require_list(payload.get("drawers"), "list_drawers.drawers")
        if not page and offset < expected_total:
            raise ValidationError("list_drawers ended before its declared total")
        for index, raw in enumerate(page):
            drawer = _require_mapping(raw, f"list_drawers.drawers[{index}]")
            drawer_id = drawer.get("drawer_id")
            if not isinstance(drawer_id, str) or not drawer_id or drawer_id in seen:
                raise ValidationError("list_drawers returned a missing or duplicate drawer_id")
            seen.add(drawer_id)
            drawers.append(drawer)
        offset += len(page)
    if expected_total is None or len(drawers) != expected_total:
        raise ValidationError("list_drawers count does not match its declared total")
    return drawers


def _fetch_drawer(client: MemoryAdminClient, descriptor: Mapping[str, Any]) -> dict[str, Any]:
    drawer_id = descriptor.get("drawer_id")
    if not isinstance(drawer_id, str) or not drawer_id:
        raise ValidationError("drawer descriptor has no drawer_id")
    payload = client.call_tool("mempalace_get_drawer", {"drawer_id": drawer_id}).payload
    if payload.get("drawer_id") != drawer_id:
        raise ValidationError("get_drawer returned a mismatched drawer_id")
    content = payload.get("content")
    metadata = payload.get("metadata")
    if not isinstance(content, str) or not isinstance(metadata, dict):
        raise ValidationError("get_drawer returned an invalid exact payload")
    for field in ("wing", "room"):
        if payload.get(field) != descriptor.get(field):
            raise ValidationError(f"get_drawer returned a mismatched {field}")
    return payload


def _group_key(drawer: Mapping[str, Any]) -> dict[str, object]:
    metadata = _require_mapping(drawer.get("metadata"), "drawer.metadata")
    common = {"wing": drawer.get("wing"), "room": drawer.get("room")}
    source_file = metadata.get("source_file")
    drawer_key = metadata.get("drawer_key")
    if isinstance(source_file, str) and source_file:
        return {**common, "source_file": source_file}
    if isinstance(drawer_key, str) and drawer_key:
        return {**common, "drawer_key": drawer_key}
    return {**common, "drawer_id": drawer.get("drawer_id")}


def _drawer_records(
    descriptors: list[dict[str, Any]], exact_drawers: list[dict[str, Any]]
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    groups: dict[bytes, list[dict[str, object]]] = defaultdict(list)
    group_values: dict[bytes, dict[str, object]] = {}

    for descriptor, drawer in zip(descriptors, exact_drawers, strict=True):
        drawer_id = str(drawer["drawer_id"])
        records.append(_record("drawer", drawer_id, drawer))
        metadata = _require_mapping(drawer["metadata"], "drawer.metadata")
        if metadata.get("type") == "diary_entry" or drawer.get("room") == "diary":
            records.append(_record("diary", drawer_id, drawer))
        if "chunk_index" in metadata:
            key = _group_key(drawer)
            canonical_key = canonical_json_bytes(key)
            group_values[canonical_key] = key
            groups[canonical_key].append(
                {"drawer_id": drawer_id, "chunk_index": metadata.get("chunk_index")}
            )
        if descriptor.get("drawer_id") != drawer_id:
            raise ValidationError("drawer ordering changed during exact export")

    for canonical_key in sorted(groups):
        key = group_values[canonical_key]
        members = sorted(groups[canonical_key], key=lambda item: str(item["drawer_id"]))
        value = {"group_key": key, "members": members}
        records.append(_record("chunk_group", _digest_id("group", key), value))
    return records


def _kg_records(client: MemoryAdminClient) -> list[dict[str, object]]:
    stats = client.call_tool("mempalace_kg_stats", {}).payload
    triples = stats.get("triples")
    if not isinstance(triples, int) or isinstance(triples, bool) or triples < 0:
        raise ValidationError("kg_stats returned an invalid triple count")
    if triples == 0:
        return []
    timeline = client.call_tool("mempalace_kg_timeline", {}).payload
    facts = _require_list(timeline.get("timeline"), "kg_timeline.timeline")
    if len(facts) != triples:
        raise ValidationError("unfiltered KG timeline does not cover every declared triple")
    records: list[dict[str, object]] = []
    for index, fact_value in enumerate(facts):
        fact = _require_mapping(fact_value, f"kg_timeline.timeline[{index}]")
        candidate_id = fact.get("triple_id") or fact.get("id")
        record_id = (
            str(candidate_id)
            if isinstance(candidate_id, str) and candidate_id
            else _digest_id("kg", fact)
        )
        records.append(_record("kg", record_id, fact))
    return records


def _safe_files(root: Path) -> Iterable[tuple[Path, str]]:
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories.sort()
        files.sort()
        for name in directories:
            candidate = current_path / name
            if candidate.is_symlink():
                raise ValidationError(f"copied palace contains a symlink directory: {candidate}")
        for name in files:
            candidate = current_path / name
            if candidate.is_symlink():
                raise ValidationError(f"copied palace contains a symlink file: {candidate}")
            file_stat = candidate.stat()
            if not stat.S_ISREG(file_stat.st_mode):
                raise ValidationError(f"copied palace contains a non-regular file: {candidate}")
            yield candidate, candidate.relative_to(root).as_posix()


def _archive_records(root: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    archive = root / "archive"
    if not archive.exists():
        return records
    for path, relative_to_archive in _safe_files(archive):
        relative = f"archive/{relative_to_archive}"
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as exc:
            raise ValidationError(f"cannot read archive file {relative}: {exc}") from exc
        for line_number, line in enumerate(lines, start=1):
            if not line:
                continue
            try:
                value: object = json.loads(line)
            except json.JSONDecodeError:
                value = {"raw_utf8": line}
            record_id = _digest_id("archive", {"path": relative, "line": line_number})
            records.append(
                _record(
                    "archive",
                    record_id,
                    {"path": relative, "line": line_number, "value": value},
                )
            )
    return records


def _sidecar_records(root: Path) -> list[dict[str, object]]:
    """Record only durable Chroma vector-index sidecars from the source corpus.

    A 3.7.1 hub may create KG/logstream WAL files, migration markers, replica
    metadata, and a supervisor PID file merely by opening a copied palace. Those
    are candidate runtime state, not source logical data, and must not be folded
    into a source export or equality comparison.
    """

    durable_names = {
        "data_level0.bin",
        "header.bin",
        "index_metadata.pickle",
        "length.bin",
        "link_lists.bin",
    }
    records: list[dict[str, object]] = []
    for path, relative in _safe_files(root):
        parts = Path(relative).parts
        if len(parts) != 2 or parts[1] not in durable_names:
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        value = {"path": relative, "size": path.stat().st_size, "sha256": digest}
        records.append(_record("sidecar", _digest_id("sidecar", relative), value))
    return records


def export_logical_records(
    client: MemoryAdminClient,
    copied_palace_root: Path,
    output: Path,
    *,
    workers: int = 8,
) -> dict[str, int]:
    """Write one canonical private logical-record input document."""

    root = require_absolute_path(str(copied_palace_root), "copied_palace_root")
    output = require_absolute_path(str(output), "output", must_exist=False)
    if not root.is_dir():
        raise ValidationError("copied_palace_root must be a directory")
    if output.exists() or output.is_symlink():
        raise ValidationError("logical-record output already exists")
    if not 1 <= workers <= MAX_WORKERS:
        raise ValidationError(f"workers must be between 1 and {MAX_WORKERS}")

    descriptors = _list_drawers(client)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        exact_drawers = list(pool.map(lambda item: _fetch_drawer(client, item), descriptors))

    records = _drawer_records(descriptors, exact_drawers)
    records.extend(_kg_records(client))
    records.extend(_archive_records(root))
    records.extend(_sidecar_records(root))
    records.sort(key=lambda item: (str(item["record_class"]), str(item["record_id"])))
    seen: set[tuple[str, str]] = set()
    counts: dict[str, int] = defaultdict(int)
    for item in records:
        key = (str(item["record_class"]), str(item["record_id"]))
        if key in seen:
            raise ValidationError(f"duplicate logical record: {key[0]}:{key[1]}")
        seen.add(key)
        counts[key[0]] += 1
    atomic_write_json(output, {"schema_version": SCHEMA_VERSION, "records": records}, 0o600)
    return dict(sorted(counts.items()))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export exact logical records through an authenticated MemPalace HTTP hub"
    )
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--copied-palace-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=8)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        counts = export_logical_records(
            MemoryAdminClient.from_config(args.config),
            args.copied_palace_root,
            args.output,
            workers=args.workers,
        )
    except (AdminClientError, OSError, ValidationError) as exc:
        print(f"logical export refused: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"record_class_counts": counts}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
