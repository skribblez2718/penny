#!/usr/bin/env python3
"""Read-only, hub-routed memory inventory and cleanup-candidate audit.

Normal operation requires an explicit supervised-hub config and an explicit
absolute output manifest.  The audit never imports a local memory peer and
never opens memory-store bytes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

from scripts.system.memory.admin_client import AdminClientError, MemoryAdminClient
from scripts.system.memory.common import ValidationError, atomic_write_json
from scripts.system.memory.hub_config import load_hub_config
from scripts.system.tiered_memory import archiver as arch

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PROPOSED_PREFIXES: List[Tuple[str, Tuple[str, int]]] = [
    ("wing_jsa/plan-", ("T2", 30)),
    ("wing_jsa/jsa-gj-", ("T2", 30)),
    ("wing_sca/", ("T2", 30)),
]
PROPOSED_KEEP = {
    "wing_jsa/jsa-learnings",
    "wing_jsa/bug_bounty_methodology",
    "wing_jsa/vulnerability_research",
    "wing_sca/sca-learnings",
}
OVERSIZE_BYTES = 20_000
DEAD_TOKENS = ["jobz"]
_NON_SKILL_WINGS = {
    "penny",
    "wing_travel",
    "wing_decisions",
    "wing_user",
    "echo",
    "piper",
    "skills",
    "ring_jsa",
}


def _live_directory_names(path: Path) -> set[str]:
    if not path.is_dir():
        return set()
    return {candidate.name for candidate in path.iterdir() if candidate.is_dir()}


LIVE_SKILLS = _live_directory_names(PROJECT_ROOT / ".pi" / "skills")


def proposed_classify(drawer: arch.DrawerMeta) -> Tuple[str, int]:
    """Apply the historical cleanup proposal without mutating current policy."""

    key = f"{drawer.wing}/{drawer.room}"
    if key in PROPOSED_KEEP:
        return ("T3", -1)
    for prefix, tier_ttl in PROPOSED_PREFIXES:
        if key.startswith(prefix):
            return tier_ttl
    return arch.classify_drawer(drawer)


def _archive_verdict(tier_ttl: Tuple[str, int], drawer: arch.DrawerMeta) -> str:
    _, ttl = tier_ttl
    if ttl < 0:
        return "keep"
    days = arch.age_days(drawer.timestamp)
    if days is None:
        return "unknown"
    return "archive" if days > ttl else "keep"


def _dead_name(wing: str, room: str) -> str:
    """Return a reason when a room refers to a known-defunct name."""

    key = f"{wing}/{room}".lower()
    for token in DEAD_TOKENS:
        if token in key:
            return f"name contains defunct token '{token}'"
    wing_match = re.match(r"wing_([a-z0-9-]+)$", wing)
    if wing_match and wing not in _NON_SKILL_WINGS and not wing.startswith("wing_test-agent"):
        skill = wing_match.group(1)
        if skill not in LIVE_SKILLS:
            return f"wing '{wing}' names a non-live skill '{skill}'"
    room_match = re.match(r"skills/([a-z0-9]+)-", room)
    if room_match and room_match.group(1) not in LIVE_SKILLS:
        return f"room '{room}' names a non-live skill '{room_match.group(1)}'"
    return ""


def _is_test(wing: str, room: str, content: str) -> bool:
    if wing.startswith("wing_test-agent"):
        return True
    if room.startswith("e2e") or "test-" in room or room.endswith("-test"):
        return True
    return (
        wing == "penny" and room == "signals" and ("Multi test" in content or "multi1_" in content)
    )


def build_audit(drawers: List[arch.DrawerMeta]) -> dict[str, object]:
    """Build a deterministic audit document from hub-returned logical drawers."""

    wings: Dict[str, Dict[str, int]] = defaultdict(lambda: {"count": 0, "bytes": 0})
    rooms: Dict[str, Dict[str, object]] = {}
    flagged: Dict[str, List[dict[str, object]]] = {
        "test_artifacts": [],
        "dead_name": [],
        "oversized": [],
        "content_mentions_dead": [],
    }
    current_rollup: Dict[str, int] = defaultdict(int)
    proposed_rollup: Dict[str, int] = defaultdict(int)
    newly_decayable = {"count": 0, "bytes": 0}

    for drawer in drawers:
        size = len((drawer.content or "").encode("utf-8"))
        wings[drawer.wing]["count"] += 1
        wings[drawer.wing]["bytes"] += size
        room_key = f"{drawer.wing}/{drawer.room}"
        room = rooms.setdefault(room_key, {"count": 0, "bytes": 0, "current": "", "proposed": ""})
        count = room.get("count")
        byte_count = room.get("bytes")
        room["count"] = (count if isinstance(count, int) else 0) + 1
        room["bytes"] = (byte_count if isinstance(byte_count, int) else 0) + size

        current = _archive_verdict(arch.classify_drawer(drawer), drawer)
        proposed = _archive_verdict(proposed_classify(drawer), drawer)
        room["current"], room["proposed"] = current, proposed
        current_rollup[current] += 1
        proposed_rollup[proposed] += 1
        if current != "archive" and proposed == "archive":
            newly_decayable["count"] += 1
            newly_decayable["bytes"] += size

        entry: dict[str, object] = {
            "id": drawer.drawer_id,
            "wing": drawer.wing,
            "room": drawer.room,
            "bytes": size,
        }
        if _is_test(drawer.wing, drawer.room, drawer.content):
            flagged["test_artifacts"].append(entry)
        dead_reason = _dead_name(drawer.wing, drawer.room)
        if dead_reason:
            flagged["dead_name"].append({**entry, "reason": dead_reason})
        if size > OVERSIZE_BYTES:
            flagged["oversized"].append(entry)
        if any(token in drawer.content.lower() for token in DEAD_TOKENS) and not dead_reason:
            flagged["content_mentions_dead"].append(entry)

    return {
        "schema_version": 1,
        "manifest_type": "memory-read-only-audit",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "total_drawers": len(drawers),
        "wings": dict(wings),
        "rooms": rooms,
        "rollup": {"current": dict(current_rollup), "proposed": dict(proposed_rollup)},
        "newly_decayable": newly_decayable,
        "proposed_prefixes": PROPOSED_PREFIXES,
        "proposed_keep": sorted(PROPOSED_KEEP),
        "flagged": flagged,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="absolute hub config path")
    parser.add_argument("--output", required=True, type=Path, help="new absolute audit path")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if not args.config.is_absolute() or not args.output.is_absolute():
            raise ValidationError("--config and --output must be explicit absolute paths")
        config = load_hub_config(args.config)
        client = MemoryAdminClient.from_hub_config(config)
        drawers = arch._fetch_all_drawers(
            lambda params: client.call_tool("mempalace_list_drawers", params).payload
        )
        audit = build_audit(drawers)
        atomic_write_json(args.output, audit)
    except (AdminClientError, OSError, ValidationError, ValueError) as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}), file=sys.stderr)
        return 2

    print(f"# MemPalace Audit (READ-ONLY) — {datetime.now(timezone.utc).date()}")
    print(f"Total drawers: {audit['total_drawers']}")
    print(f"Full manifest: {args.output}")
    print("Nothing was modified; all memory reads used the authenticated hub.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
