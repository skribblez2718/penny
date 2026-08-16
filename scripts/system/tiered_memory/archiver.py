"""Tiered-memory retention policy and hub-routed T2→T4 operations.

The command is a dry-run planner unless ``--apply`` is supplied.  Planning
writes an immutable, content-hash-bound manifest.  Applying requires that exact
manifest plus a new operation journal; all online reads/deletes go through the
authenticated HTTP hub.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from scripts.system.memory.admin_client import AdminClientError, MemoryAdminClient
from scripts.system.memory.common import (
    ValidationError,
    atomic_write_json,
    canonical_json_bytes,
    load_json_object,
    require_sha256,
    require_utc_timestamp,
    sha256_bytes,
    sha256_file,
    utc_now,
)
from scripts.system.memory.hub_config import HubConfig, load_hub_config

RETENTION_SCHEMA_VERSION = 1
RETENTION_MANIFEST_TYPE = "memory-retention-plan"
RETENTION_JOURNAL_TYPE = "memory-retention-operation-journal"
DEFAULT_PAGE_SIZE = 100

# Tier definitions: wing/room pattern → (tier, ttl_days)
TIER_CONFIG: Dict[str, Tuple[str, int]] = {
    "penny/audit": ("T2", 30),
    "penny/diary": ("T2", 90),
    "penny/skills": ("T3", -1),
    "penny/architecture": ("T3", -1),
    "penny/decisions": ("T3", -1),
}

# Unclassified rooms are kept by default. Decay is always opt-in.
DEFAULT_ARCHIVE_TIER = "T4"
DEFAULT_ARCHIVE_TTL_DAYS = -1

TIER_PREFIX_CONFIG: List[Tuple[str, Tuple[str, int]]] = [
    ("penny/plan-", ("T2", 30)),
    ("penny/skills/", ("T2", 30)),
    ("penny/jsa-gj-", ("T2", 30)),
    ("penny/cve-validate", ("T2", 30)),
    ("penny/compactions", ("T2", 90)),
    ("penny/session_distill", ("T2", 30)),
]


def _load_legacy_skill_room_rules() -> (
    Tuple[Dict[str, Tuple[str, int]], List[Tuple[str, Tuple[str, int]]]]
):
    """Load planning classifications for the historical skill-room corpus.

    The file is neither a live skill registry nor deletion authority. It can only
    classify candidates in a dry-run plan; apply still requires the separately
    reviewed immutable retention manifest and operation journal.
    """

    manifest = Path(__file__).resolve().with_name("skill_rooms.json")
    exact: Dict[str, Tuple[str, int]] = {}
    prefixes: List[Tuple[str, Tuple[str, int]]] = []
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return exact, prefixes
    if data.get("classification") != "legacy-corpus":
        return exact, prefixes
    for config in (data.get("skills") or {}).values():
        if (
            not isinstance(config, dict)
            or config.get("status") != "legacy-corpus"
            or config.get("convention") != "dedicated-wing"
        ):
            continue
        wing = config.get("wing")
        if not isinstance(wing, str) or not wing:
            continue
        ttl = int(config.get("ttl_days", 30))
        for room in config.get("curated_rooms", []):
            exact[f"{wing}/{room}"] = ("T3", -1)
        for prefix in config.get("scratch_prefixes", [""]):
            prefixes.append((f"{wing}/{prefix}", ("T2", ttl)))
    return exact, prefixes


_SKILL_EXACT, _SKILL_PREFIXES = _load_legacy_skill_room_rules()
TIER_CONFIG.update(_SKILL_EXACT)
TIER_PREFIX_CONFIG.extend(_SKILL_PREFIXES)


@dataclass
class DrawerMeta:
    """Minimal logical drawer record needed for retention and cold recovery."""

    drawer_id: str
    wing: str
    room: str
    timestamp: str
    content: str = ""
    recall_count: int = 0
    last_recalled_at: str = ""


def parse_iso(timestamp: str) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp; missing/unparseable means age unknown."""

    if not timestamp:
        return None
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def age_days(timestamp: str, now: Optional[datetime] = None) -> Optional[float]:
    """Return age in days, or ``None`` for an unsafe/unknown timestamp."""

    created = parse_iso(timestamp)
    if created is None:
        return None
    active_now = now or datetime.now(timezone.utc)
    if active_now.tzinfo is None:
        active_now = active_now.replace(tzinfo=timezone.utc)
    return (active_now - created).total_seconds() / 86400.0


def classify_drawer(drawer: DrawerMeta) -> Tuple[str, int]:
    """Return ``(tier, ttl_days)`` using exact then longest-prefix rules."""

    key = f"{drawer.wing}/{drawer.room}"
    if key in TIER_CONFIG:
        return TIER_CONFIG[key]
    best: Optional[Tuple[str, Tuple[str, int]]] = None
    for prefix, config in TIER_PREFIX_CONFIG:
        if key.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, config)
    return best[1] if best is not None else (DEFAULT_ARCHIVE_TIER, DEFAULT_ARCHIVE_TTL_DAYS)


def effective_ttl_days(drawer: DrawerMeta, base_ttl: int) -> int:
    """Extend TTL up to fourfold when real recall demonstrates reuse."""

    if base_ttl < 0:
        return base_ttl
    return base_ttl * min(1 + (drawer.recall_count or 0), 4)


def should_archive(drawer: DrawerMeta, now: Optional[datetime] = None) -> Tuple[bool, str]:
    """Return an archival decision and reproducible reason."""

    tier, base_ttl = classify_drawer(drawer)
    if base_ttl < 0:
        return False, f"{tier}: permanent"
    ttl_days = effective_ttl_days(drawer, base_ttl)
    days = age_days(drawer.timestamp, now)
    if days is None:
        return False, f"{tier}: undated (kept)"
    if days > ttl_days:
        return True, f"{tier}: {days:.1f}d > {ttl_days}d TTL (recall={drawer.recall_count})"
    return False, f"{tier}: {days:.1f}d <= {ttl_days}d TTL"


def sweep_for_archival(
    drawer_list: List[DrawerMeta], now: Optional[datetime] = None
) -> Dict[str, List[DrawerMeta]]:
    """Classify drawers into keep/archive/unknown without mutating memory."""

    result: Dict[str, List[DrawerMeta]] = {"keep": [], "archive": [], "unknown": []}
    for drawer in drawer_list:
        tier, base_ttl = classify_drawer(drawer)
        if tier == "T3" or base_ttl < 0:
            result["keep"].append(drawer)
            continue
        if age_days(drawer.timestamp, now) is None:
            result["unknown"].append(drawer)
            continue
        should, _ = should_archive(drawer, now)
        result["archive" if should else "keep"].append(drawer)
    return result


def archive_drawers(
    drawers: List[DrawerMeta],
    deleter: Callable[[str], bool],
    archiver: Optional[Callable[[DrawerMeta], str]] = None,
) -> Dict[str, int]:
    """Pure injectable helper used by hermetic policy lifecycle tests."""

    stats = {"deleted": 0, "archived": 0, "failed": 0}
    for drawer in drawers:
        try:
            if archiver:
                archiver(drawer)
                stats["archived"] += 1
            if deleter(drawer.drawer_id):
                stats["deleted"] += 1
            else:
                stats["failed"] += 1
        except Exception:
            stats["failed"] += 1
    return stats


def weekly_archival_report(drawer_list: List[DrawerMeta], now: Optional[datetime] = None) -> str:
    """Produce a human-readable summary of the planned retention operation."""

    sweep = sweep_for_archival(drawer_list, now)
    lines = [
        "# Weekly Archival Report",
        "",
        f"**Keep:** {len(sweep['keep'])} drawers",
        f"**Archive:** {len(sweep['archive'])} drawers",
        f"**Unknown:** {len(sweep['unknown'])} drawers",
        "",
    ]
    if sweep["archive"]:
        lines.append("## Items to Archive")
        for drawer in sweep["archive"]:
            _, reason = should_archive(drawer, now)
            lines.append(f"- `{drawer.drawer_id}` ({drawer.wing}/{drawer.room}) — {reason}")
    lines.extend(["", "## Tier Breakdown"])
    tier_counts: Dict[str, int] = {}
    for drawer in drawer_list:
        tier, _ = classify_drawer(drawer)
        tier_counts[tier] = tier_counts.get(tier, 0) + 1
    for tier, count in sorted(tier_counts.items()):
        lines.append(f"- {tier}: {count} drawers")
    return "\n".join(lines)


def _drawer_from_payload(raw: object) -> DrawerMeta:
    if not isinstance(raw, dict):
        raise ValidationError("hub get_drawer returned a non-object drawer")
    drawer_id = raw.get("drawer_id", raw.get("id"))
    if not isinstance(drawer_id, str) or not drawer_id:
        raise ValidationError("hub get_drawer returned a drawer without an id")
    content = raw.get("content", raw.get("text", raw.get("document", "")))
    if not isinstance(content, str):
        raise ValidationError(f"drawer {drawer_id} has non-text content")
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    return DrawerMeta(
        drawer_id=drawer_id,
        wing=str(raw.get("wing", metadata.get("wing", ""))),
        room=str(raw.get("room", metadata.get("room", ""))),
        timestamp=str(
            raw.get(
                "filed_at",
                raw.get("created_at", metadata.get("filed_at", metadata.get("date", ""))),
            )
        ),
        content=content,
        recall_count=int(raw.get("recall_count", metadata.get("recall_count", 0)) or 0),
        last_recalled_at=str(raw.get("last_recalled_at", metadata.get("last_recalled_at", ""))),
    )


def _fetch_all_drawers(
    client: MemoryAdminClient,
    page: int = DEFAULT_PAGE_SIZE,
) -> List[DrawerMeta]:
    """Page descriptors, then fetch exact content through supported hub tools."""

    if page <= 0:
        raise ValueError("page must be positive")
    drawers: List[DrawerMeta] = []
    offset = 0
    expected_total: int | None = None
    while expected_total is None or offset < expected_total:
        result = client.call_tool(
            "mempalace_list_drawers", {"limit": page, "offset": offset}
        ).payload
        batch = result.get("drawers", [])
        total = result.get("total")
        if not isinstance(batch, list) or not isinstance(total, int) or isinstance(total, bool):
            raise ValidationError("hub list_drawers payload has invalid drawers/total fields")
        if expected_total is None:
            expected_total = total
        elif total != expected_total:
            raise ValidationError("hub drawer total changed during retention planning")
        if not batch and offset < expected_total:
            raise ValidationError("hub list_drawers ended before its declared total")
        for raw in batch:
            if not isinstance(raw, dict) or not isinstance(raw.get("drawer_id"), str):
                raise ValidationError("hub list_drawers returned an invalid drawer descriptor")
            exact = client.call_tool(
                "mempalace_get_drawer", {"drawer_id": raw["drawer_id"]}
            ).payload
            drawers.append(_drawer_from_payload(exact))
        offset += len(batch)
    if expected_total is None or len(drawers) != expected_total:
        raise ValidationError("hub list_drawers total does not match exact reads")
    return drawers


def _policy_sha256() -> str:
    policy = {
        "exact": sorted((key, list(value)) for key, value in TIER_CONFIG.items()),
        "prefix": sorted((key, list(value)) for key, value in TIER_PREFIX_CONFIG),
        "default": [DEFAULT_ARCHIVE_TIER, DEFAULT_ARCHIVE_TTL_DAYS],
    }
    return sha256_bytes(canonical_json_bytes(policy))


def _manifest_record(drawer: DrawerMeta, now: datetime) -> dict[str, Any]:
    should, reason = should_archive(drawer, now)
    if not should:
        raise ValidationError(f"drawer is not an archival candidate: {drawer.drawer_id}")
    record = asdict(drawer)
    record["content_sha256"] = sha256_bytes(drawer.content.encode("utf-8"))
    record["reason"] = reason
    return record


def build_retention_manifest(
    drawers: List[DrawerMeta], config: HubConfig, *, now: datetime
) -> dict[str, Any]:
    """Build a deterministic, content-bound dry-run plan."""

    candidates = sweep_for_archival(drawers, now)["archive"]
    records = sorted(
        (_manifest_record(drawer, now) for drawer in candidates),
        key=lambda item: item["drawer_id"],
    )
    return {
        "schema_version": RETENTION_SCHEMA_VERSION,
        "manifest_type": RETENTION_MANIFEST_TYPE,
        "created_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "palace_id": config.palace_id,
        "hub_config_sha256": config.config_sha256,
        "policy_sha256": _policy_sha256(),
        "records": records,
        "summary": {
            "candidate_count": len(records),
            "content_bytes": sum(len(record["content"].encode("utf-8")) for record in records),
        },
    }


def _validated_record(raw: object, index: int) -> tuple[dict[str, Any], int]:
    expected_fields = {
        "drawer_id",
        "wing",
        "room",
        "timestamp",
        "content",
        "recall_count",
        "last_recalled_at",
        "content_sha256",
        "reason",
    }
    if not isinstance(raw, dict) or set(raw) != expected_fields:
        raise ValidationError(f"retention records[{index}] has invalid fields")
    record = dict(raw)
    drawer_id = record.get("drawer_id")
    if not isinstance(drawer_id, str) or not drawer_id:
        raise ValidationError(f"retention records[{index}].drawer_id is invalid")
    content = record.get("content")
    if not isinstance(content, str):
        raise ValidationError(f"retention records[{index}].content is invalid")
    digest = require_sha256(record.get("content_sha256"), f"records[{index}].content_sha256")
    if digest != sha256_bytes(content.encode("utf-8")):
        raise ValidationError(f"retention records[{index}] content hash mismatch")
    return record, len(content.encode("utf-8"))


def _validate_manifest_identity(document: dict[str, Any], config: HubConfig) -> None:
    expected = {
        "schema_version",
        "manifest_type",
        "created_at",
        "palace_id",
        "hub_config_sha256",
        "policy_sha256",
        "records",
        "summary",
    }
    if set(document) != expected:
        raise ValidationError("retention manifest has unknown or missing fields")
    if document.get("schema_version") != RETENTION_SCHEMA_VERSION:
        raise ValidationError(f"retention schema_version must be {RETENTION_SCHEMA_VERSION}")
    if document.get("manifest_type") != RETENTION_MANIFEST_TYPE:
        raise ValidationError(f"retention manifest_type must be {RETENTION_MANIFEST_TYPE}")
    require_utc_timestamp(document.get("created_at"), "retention.created_at")
    if document.get("palace_id") != config.palace_id:
        raise ValidationError("retention manifest palace_id does not match hub config")
    if document.get("hub_config_sha256") != config.config_sha256:
        raise ValidationError("retention manifest hub config hash does not match")
    if document.get("policy_sha256") != _policy_sha256():
        raise ValidationError("retention policy changed after dry-run; make a new manifest")


def validate_retention_manifest(path: Path, config: HubConfig) -> dict[str, Any]:
    """Validate a dry-run plan and bind it to the active hub/policy."""

    document = load_json_object(path)
    _validate_manifest_identity(document, config)
    records = document.get("records")
    if not isinstance(records, list):
        raise ValidationError("retention records must be a list")
    ids: list[str] = []
    content_bytes = 0
    for index, raw in enumerate(records):
        record, record_bytes = _validated_record(raw, index)
        ids.append(record["drawer_id"])
        content_bytes += record_bytes
    if ids != sorted(ids) or len(ids) != len(set(ids)):
        raise ValidationError("retention records must be unique and sorted by drawer_id")
    if document.get("summary") != {
        "candidate_count": len(records),
        "content_bytes": content_bytes,
    }:
        raise ValidationError("retention summary does not match records")
    return document


class OperationJournal:
    """Append-and-fsync journal created before any retention side effect."""

    def __init__(self, path: Path) -> None:
        if not path.is_absolute():
            raise ValidationError("operation journal path must be absolute")
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise ValidationError(f"refusing to overwrite operation journal: {path}") from exc
        self.path = path
        self._handle = os.fdopen(descriptor, "w", encoding="utf-8")

    def append(self, event: dict[str, Any]) -> None:
        self._handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
        self._handle.flush()
        os.fsync(self._handle.fileno())

    def close(self) -> None:
        self._handle.close()

    def __enter__(self) -> "OperationJournal":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _append_cold_record(archive_root: Path, record: dict[str, Any]) -> Path:
    safe_room = f"{record['wing']}--{record['room']}".replace("/", "_").replace("..", "_")
    timestamp = parse_iso(str(record["timestamp"])) or datetime.now(timezone.utc)
    destination = archive_root / safe_room / f"{timestamp:%Y-%m}.jsonl"
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = canonical_json_bytes(
        {
            "drawer_id": record["drawer_id"],
            "wing": record["wing"],
            "room": record["room"],
            "filed_at": record["timestamp"],
            "recall_count": record["recall_count"],
            "last_recalled_at": record["last_recalled_at"],
            "content": record["content"],
            "content_sha256": record["content_sha256"],
        }
    )
    descriptor = os.open(destination, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                raise OSError("cold archive write made no progress")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return destination


def _make_jsonl_archiver(archive_root: str) -> Callable[[DrawerMeta], str]:
    """Return a cold-writer callable for hermetic compatibility checks."""

    root = Path(archive_root)

    def archive(drawer: DrawerMeta) -> str:
        record = asdict(drawer)
        record["content_sha256"] = sha256_bytes(drawer.content.encode("utf-8"))
        return str(_append_cold_record(root, record))

    return archive


def _record_matches_live(record: dict[str, Any], current: DrawerMeta) -> bool:
    digest = record.get("content_sha256")
    return (
        record.get("drawer_id") == current.drawer_id
        and record.get("wing") == current.wing
        and record.get("room") == current.room
        and record.get("timestamp") == current.timestamp
        and isinstance(digest, str)
        and digest == sha256_bytes(current.content.encode("utf-8"))
    )


def apply_retention_manifest(
    manifest_path: Path,
    journal_path: Path,
    config: HubConfig,
    client: MemoryAdminClient,
) -> dict[str, int]:
    """Cold-archive then hub-delete every still-exact manifest candidate."""

    manifest = validate_retention_manifest(manifest_path, config)
    current = {
        drawer.drawer_id: drawer for drawer in _fetch_all_drawers(client, page=DEFAULT_PAGE_SIZE)
    }
    stats = {"archived": 0, "deleted": 0, "failed": 0, "stale": 0}
    with OperationJournal(journal_path) as journal:
        journal.append(
            {
                "schema_version": RETENTION_SCHEMA_VERSION,
                "journal_type": RETENTION_JOURNAL_TYPE,
                "event": "apply-started",
                "at": utc_now(),
                "palace_id": config.palace_id,
                "manifest_sha256": sha256_file(manifest_path),
            }
        )
        for record in manifest["records"]:
            drawer_id = record["drawer_id"]
            live = current.get(drawer_id)
            if live is None or not _record_matches_live(record, live):
                stats["stale"] += 1
                stats["failed"] += 1
                journal.append({"event": "stale-refused", "at": utc_now(), "drawer_id": drawer_id})
                continue
            try:
                archived_path = _append_cold_record(config.data_roots["archive"], record)
                stats["archived"] += 1
                journal.append(
                    {
                        "event": "cold-archived",
                        "at": utc_now(),
                        "drawer_id": drawer_id,
                        "content_sha256": record["content_sha256"],
                        "archive_path": str(archived_path),
                    }
                )
                journal.append(
                    {"event": "delete-requested", "at": utc_now(), "drawer_id": drawer_id}
                )
                response = client.call_tool("mempalace_delete_drawer", {"drawer_id": drawer_id})
                success = response.payload.get("success") is True
                journal.append(
                    {
                        "event": "delete-result",
                        "at": utc_now(),
                        "drawer_id": drawer_id,
                        "request_id": response.request_id,
                        "success": success,
                    }
                )
                if success:
                    stats["deleted"] += 1
                else:
                    stats["failed"] += 1
            except (AdminClientError, OSError, ValidationError) as exc:
                stats["failed"] += 1
                journal.append(
                    {
                        "event": "operation-failed",
                        "at": utc_now(),
                        "drawer_id": drawer_id,
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
        journal.append({"event": "apply-finished", "at": utc_now(), "stats": stats})
    return stats


def _absolute_argument(path: Path, field: str) -> Path:
    if not path.is_absolute():
        raise ValidationError(f"{field} must be an explicit absolute path")
    return path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Plan or apply hub-routed memory retention")
    parser.add_argument("--config", required=True, type=Path, help="absolute hub config path")
    parser.add_argument("--manifest", required=True, type=Path, help="absolute plan path")
    parser.add_argument("--apply", action="store_true", help="apply the supplied dry-run manifest")
    parser.add_argument(
        "--journal", type=Path, help="new absolute operation journal (required with --apply)"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Plan by default; apply only with an exact manifest and operation journal."""

    args = _parser().parse_args(argv)
    try:
        config_path = _absolute_argument(args.config, "config")
        manifest_path = _absolute_argument(args.manifest, "manifest")
        config = load_hub_config(config_path)
        client = MemoryAdminClient.from_hub_config(config)
        if args.apply:
            if args.journal is None:
                raise ValidationError("--journal is required with --apply")
            journal_path = _absolute_argument(args.journal, "journal")
            stats = apply_retention_manifest(manifest_path, journal_path, config, client)
            print(json.dumps({"operation": "apply", "stats": stats}, sort_keys=True))
            return 0 if stats["failed"] == 0 else 1

        if args.journal is not None:
            raise ValidationError("--journal is valid only with --apply")
        drawers = _fetch_all_drawers(client, page=DEFAULT_PAGE_SIZE)
        now = datetime.now(timezone.utc)
        manifest = build_retention_manifest(drawers, config, now=now)
        atomic_write_json(manifest_path, manifest)
        print(weekly_archival_report(drawers, now))
        print(f"\nDry-run manifest: {manifest_path}")
        print("No memory was modified. Review the manifest before --apply.")
        return 0
    except (AdminClientError, OSError, ValidationError, ValueError) as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
