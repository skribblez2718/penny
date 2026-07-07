"""Tiered Memory Archival — age-based TTL enforcement for T2→T4 transition."""

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

# Tier definitions: wing/room pattern → (tier, ttl_days)
TIER_CONFIG: Dict[str, Tuple[str, int]] = {
    "penny/signals": ("T2", 7),
    "penny/outcomes": ("T2", 30),
    "penny/audit": ("T2", 30),
    "penny/diary": ("T2", 90),
    "penny/skills": ("T3", -1),  # permanent
    "penny/architecture": ("T3", -1),  # permanent
    "penny/digests": ("T3", -1),  # permanent
    "penny/decisions": ("T3", -1),  # permanent
}

# Unclassified rooms are KEPT by default (ttl < 0). Decay is opt-in per room
# via TIER_CONFIG / the prefix rules below, so a mis-labelled or brand-new room
# can never be silently mass-archived on a cron run.
DEFAULT_ARCHIVE_TIER = "T4"
DEFAULT_ARCHIVE_TTL_DAYS = -1

# Longest-prefix room patterns for session-scoped scratch that should decay
# even though the exact room name is unique per run. Checked after the exact
# TIER_CONFIG lookup. (wing/room-prefix -> (tier, ttl_days))
TIER_PREFIX_CONFIG: List[Tuple[str, Tuple[str, int]]] = [
    ("penny/plan-", ("T2", 30)),
    ("penny/skills/", ("T2", 30)),
    ("penny/jsa-gj-", ("T2", 30)),
    ("penny/cve-validate", ("T2", 30)),
    ("penny/compactions", ("T2", 90)),
    ("penny/session_distill", ("T2", 30)),
]


@dataclass
class DrawerMeta:
    """Minimal drawer metadata for archival decisions."""

    drawer_id: str
    wing: str
    room: str
    timestamp: str  # ISO-8601 (the drawer's ``filed_at`` metadata)
    content: str = ""
    recall_count: int = 0
    last_recalled_at: str = ""


def parse_iso(ts: str) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp, returning None if absent/unparseable.

    Returning None rather than ``now`` is deliberate: an undated drawer must be
    treated as age-unknown and KEPT, never silently aged to 0 days (the old
    bug that made every drawer look brand new so nothing ever archived).
    Naive timestamps are normalized to UTC so downstream subtraction is safe.
    """
    if not ts:
        return None
    ts = ts.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def age_days(ts: str, now: Optional[datetime] = None) -> Optional[float]:
    """Return age in days, or None if the timestamp is missing/unparseable."""
    created = parse_iso(ts)
    if created is None:
        return None
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (now - created).total_seconds() / 86400.0


def classify_drawer(drawer: DrawerMeta) -> Tuple[str, int]:
    """Return (tier, ttl_days) for a drawer.

    Exact ``wing/room`` match wins; then the longest matching room prefix;
    otherwise the (keep-by-default) fallback.
    """
    key = f"{drawer.wing}/{drawer.room}"
    if key in TIER_CONFIG:
        return TIER_CONFIG[key]
    best: Optional[Tuple[str, Tuple[str, int]]] = None
    for prefix, cfg in TIER_PREFIX_CONFIG:
        if key.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, cfg)
    if best is not None:
        return best[1]
    return (DEFAULT_ARCHIVE_TIER, DEFAULT_ARCHIVE_TTL_DAYS)


def effective_ttl_days(drawer: DrawerMeta, base_ttl: int) -> int:
    """Extend a drawer's TTL by demonstrated reuse (recall-modulated decay).

    A drawer recalled repeatedly is worth keeping longer: a piece recalled 3+
    times lives up to 4x its class TTL. Reuse is the retention signal.
    """
    if base_ttl < 0:
        return base_ttl
    recall = drawer.recall_count or 0
    multiplier = min(1 + recall, 4)
    return base_ttl * multiplier


def should_archive(drawer: DrawerMeta, now: Optional[datetime] = None) -> Tuple[bool, str]:
    """Return (should_archive, reason) for a drawer.

    Permanent tiers (ttl < 0) never archive. Undated drawers are kept.
    """
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
    drawer_list: List[DrawerMeta],
    now: Optional[datetime] = None,
) -> Dict[str, List[DrawerMeta]]:
    """Classify all drawers into keep, archive, unknown.

    Returns {"keep": [...], "archive": [...], "unknown": [...]}
    """
    result: Dict[str, List[DrawerMeta]] = {
        "keep": [],
        "archive": [],
        "unknown": [],
    }
    for drawer in drawer_list:
        tier, base_ttl = classify_drawer(drawer)
        if tier == "T3" or base_ttl < 0:
            result["keep"].append(drawer)
            continue
        days = age_days(drawer.timestamp, now)
        if days is None:
            result["unknown"].append(drawer)
            continue
        should, _ = should_archive(drawer, now)
        (result["archive"] if should else result["keep"]).append(drawer)
    return result


def archive_drawers(
    drawers: List[DrawerMeta],
    deleter: Callable[[str], bool],
    archiver: Optional[Callable[[DrawerMeta], str]] = None,
) -> Dict[str, int]:
    """Archive (delete from T2, optionally write to T4) a list of drawers.

    Returns stats: {"deleted": n, "archived": n, "failed": n}
    """
    stats = {"deleted": 0, "archived": 0, "failed": 0}
    for drawer in drawers:
        try:
            if archiver:
                archiver(drawer)
                stats["archived"] += 1
            ok = deleter(drawer.drawer_id)
            if ok:
                stats["deleted"] += 1
            else:
                stats["failed"] += 1
        except Exception:
            stats["failed"] += 1
    return stats


def weekly_archival_report(
    drawer_list: List[DrawerMeta],
    now: Optional[datetime] = None,
) -> str:
    """Produce a human-readable summary of what would be archived."""
    sweep = sweep_for_archival(drawer_list, now)
    lines = ["# Weekly Archival Report", ""]
    lines.append(f"**Keep:** {len(sweep['keep'])} drawers")
    lines.append(f"**Archive:** {len(sweep['archive'])} drawers")
    lines.append(f"**Unknown:** {len(sweep['unknown'])} drawers")
    lines.append("")
    if sweep["archive"]:
        lines.append("## Items to Archive")
        for d in sweep["archive"]:
            _, reason = should_archive(d, now)
            lines.append(f"- `{d.drawer_id}` ({d.wing}/{d.room}) — {reason}")
    lines.append("")
    lines.append("## Tier Breakdown")
    tier_counts: Dict[str, int] = {}
    for d in drawer_list:
        tier, _ = classify_drawer(d)
        tier_counts[tier] = tier_counts.get(tier, 0) + 1
    for tier, count in sorted(tier_counts.items()):
        lines.append(f"- {tier}: {count} drawers")
    return "\n".join(lines)


def _fetch_all_drawers(list_drawers: Callable[[dict], dict], page: int = 10000) -> List[DrawerMeta]:
    """Page through the entire palace (not just the first 1000 drawers)."""
    metas: List[DrawerMeta] = []
    offset = 0
    while True:
        result = list_drawers({"limit": page, "offset": offset, "include_content": True})
        batch = result.get("drawers", []) if isinstance(result, dict) else []
        if not batch:
            break
        for d in batch:
            metas.append(
                DrawerMeta(
                    drawer_id=d.get("id", ""),
                    wing=d.get("wing", ""),
                    room=d.get("room", ""),
                    timestamp=d.get("filed_at", ""),
                    content=d.get("content", ""),
                    recall_count=int(d.get("recall_count", 0) or 0),
                    last_recalled_at=d.get("last_recalled_at", ""),
                )
            )
        if len(batch) < page:
            break
        offset += page
    return metas


def _make_jsonl_archiver(archive_root: str) -> Callable[[DrawerMeta], str]:
    """Return an archiver that appends a drawer to grep-able cold storage
    (one JSONL line per drawer) BEFORE it is deleted from the hot store."""
    import json as _json

    def _archive(drawer: DrawerMeta) -> str:
        safe = f"{drawer.wing}--{drawer.room}".replace("/", "_").replace("..", "_")
        sub = os.path.join(archive_root, safe)
        os.makedirs(sub, exist_ok=True)
        dt = parse_iso(drawer.timestamp) or datetime.now(timezone.utc)
        path = os.path.join(sub, f"{dt.strftime('%Y-%m')}.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(
                _json.dumps(
                    {
                        "drawer_id": drawer.drawer_id,
                        "wing": drawer.wing,
                        "room": drawer.room,
                        "filed_at": drawer.timestamp,
                        "recall_count": drawer.recall_count,
                        "content": drawer.content,
                    }
                )
                + "\n"
            )
        return path

    return _archive


if __name__ == "__main__":
    import sys

    # Resolve bridge
    bridge_path = os.environ.get("PI_MEMORY_BRIDGE")
    if not bridge_path:
        project_root = os.environ.get("PROJECT_ROOT", os.getcwd())
        bridge_path = os.path.join(project_root, "scripts", "system", "bridge", "memory_bridge.py")

    sys.path.insert(0, os.path.dirname(bridge_path))
    from memory_bridge import tool_list_drawers, tool_delete_drawer

    # Resolve the palace path for cold storage, degrading gracefully if the
    # bridge exposes no _config (e.g. a test stub).
    try:
        from memory_bridge import _config as _mp_config

        palace_path = str(_mp_config.palace_path)
    except Exception:
        palace_path = os.environ.get("MEMPALACE_PATH") or os.path.join(os.getcwd(), ".mempalace")

    # Fetch every drawer (paginated).
    drawer_metas = _fetch_all_drawers(tool_list_drawers)

    # Report
    report = weekly_archival_report(drawer_metas)
    print(report)

    # Execute archival — write to T4 cold storage, then delete from the hot store.
    sweep = sweep_for_archival(drawer_metas)
    to_archive = sweep["archive"]
    if to_archive:
        archive_root = os.path.join(palace_path, "archive")
        print(f"\nArchiving {len(to_archive)} expired drawers → {archive_root} ...")

        def deleter(drawer_id: str) -> bool:
            r = tool_delete_drawer({"drawer_id": drawer_id})
            return r.get("success", False) if isinstance(r, dict) else False

        stats = archive_drawers(to_archive, deleter, archiver=_make_jsonl_archiver(archive_root))
        print(
            f"Deleted: {stats['deleted']}, Archived: {stats['archived']}, Failed: {stats['failed']}"
        )
    else:
        print("\nNo expired drawers to archive.")
