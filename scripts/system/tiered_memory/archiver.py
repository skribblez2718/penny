"""Tiered Memory Archival — age-based TTL enforcement for T2→T4 transition."""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

# Tier definitions: wing/room pattern → (tier, ttl_days)
TIER_CONFIG: Dict[str, Tuple[str, int]] = {
    "penny/signals": ("T2", 7),
    "penny/outcomes": ("T2", 30),
    "penny/audit": ("T2", 30),
    "penny/diary": ("T2", 90),
    "penny/skills": ("T3", -1),      # permanent
    "penny/architecture": ("T3", -1),  # permanent
    "penny/digests": ("T3", -1),      # permanent
    "penny/decisions": ("T3", -1),    # permanent
}

DEFAULT_ARCHIVE_TIER = "T4"
DEFAULT_ARCHIVE_TTL_DAYS = 90


@dataclass
class DrawerMeta:
    """Minimal drawer metadata for archival decisions."""

    drawer_id: str
    wing: str
    room: str
    timestamp: str  # ISO-8601
    content: str = ""


def parse_iso(ts: str) -> datetime:
    """Parse ISO-8601 string. Handle Z suffix."""
    ts = ts.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        # Fallback
        return datetime.now(timezone.utc)


def age_days(ts: str, now: Optional[datetime] = None) -> float:
    """Return age in days."""
    created = parse_iso(ts)
    now = now or datetime.now(timezone.utc)
    return (now - created).total_seconds() / 86400.0


def classify_drawer(drawer: DrawerMeta) -> Tuple[str, int]:
    """Return (tier, ttl_days) for a drawer based on wing/room."""
    key = f"{drawer.wing}/{drawer.room}"
    return TIER_CONFIG.get(key, (DEFAULT_ARCHIVE_TIER, DEFAULT_ARCHIVE_TTL_DAYS))


def should_archive(drawer: DrawerMeta, now: Optional[datetime] = None) -> Tuple[bool, str]:
    """Return (should_archive, reason) for a drawer.

    Permanent tiers (ttl < 0) never archive.
    """
    tier, ttl_days = classify_drawer(drawer)
    if ttl_days < 0:
        return False, f"{tier}: permanent"

    days = age_days(drawer.timestamp, now)
    if days > ttl_days:
        return True, f"{tier}: {days:.1f}d > {ttl_days}d TTL"
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
        tier, ttl_days = classify_drawer(drawer)
        if tier == "T3":
            result["keep"].append(drawer)
            continue
        if ttl_days >= 0:
            should, _ = should_archive(drawer, now)
            if should:
                result["archive"].append(drawer)
            else:
                result["keep"].append(drawer)
        else:
            result["unknown"].append(drawer)
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


if __name__ == "__main__":
    import os
    import sys

    # Resolve bridge
    bridge_path = os.environ.get("PI_MEMORY_BRIDGE")
    if not bridge_path:
        project_root = os.environ.get("PROJECT_ROOT", os.getcwd())
        bridge_path = os.path.join(
            project_root, "scripts", "system", "bridge", "memory_bridge.py"
        )

    sys.path.insert(0, os.path.dirname(bridge_path))
    from memory_bridge import tool_list_drawers, tool_delete_drawer

    # Fetch all drawers
    result = tool_list_drawers({})
    drawers_raw = result.get("drawers", []) if isinstance(result, dict) else []

    drawer_metas = []
    for d in drawers_raw:
        dm = DrawerMeta(
            drawer_id=d.get("id", ""),
            wing=d.get("wing", ""),
            room=d.get("room", ""),
            timestamp=d.get("timestamp", ""),
            content=d.get("content", ""),
        )
        drawer_metas.append(dm)

    # Report
    report = weekly_archival_report(drawer_metas)
    print(report)

    # Execute archival
    sweep = sweep_for_archival(drawer_metas)
    to_archive = sweep["archive"]
    if to_archive:
        print(f"\nArchiving {len(to_archive)} expired drawers...")

        def deleter(drawer_id: str) -> bool:
            r = tool_delete_drawer({"drawer_id": drawer_id})
            return r.get("success", False) if isinstance(r, dict) else False

        stats = archive_drawers(to_archive, deleter)
        print(f"Deleted: {stats['deleted']}, Archived: {stats['archived']}, Failed: {stats['failed']}")
    else:
        print("\nNo expired drawers to archive.")
