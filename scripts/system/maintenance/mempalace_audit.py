#!/usr/bin/env python3
"""Read-only MemPalace audit — Phase 1 of the Item-5 memory cleanup.

NEVER deletes or writes to the store. It enumerates every drawer (reusing the
archiver's own paginator + tier classifier so the audit and the real sweep can
never disagree), classifies each against the CURRENT policy and a PROPOSED
policy (dedicated-wing scratch decay), cross-references room/wing names against
the live skills/extensions on disk, and flags:

  * TEST artifacts (safe delete)                      — wing_test-agent-*, e2e/test rooms
  * DEAD-NAME references (review/delete)              — `jobz` + non-live skill/extension wings/rooms
  * OVERSIZED raw-transcript drawers (review)         — content > 20 KB (raw jsonl blobs)
  * TRANSIENT scratch a decay rule would age out      — the 77% JSA bulk

It prints a summary and writes a full JSON manifest to /tmp for the
human-gated Phase 2. Nothing here mutates the palace.

    .venv/bin/python scripts/system/maintenance/mempalace_audit.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

_HERE = Path(__file__).resolve()
_ROOT = _HERE.parents[3]
for _p in (_ROOT / "scripts" / "system" / "tiered_memory", _ROOT / "scripts" / "system" / "bridge"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import archiver as arch  # noqa: E402
from memory_bridge import tool_list_drawers  # noqa: E402

# ── Proposed policy (SIMULATED here — not written to archiver.py) ─────────────
# Dedicated-wing scratch uses session-id-prefixed room names (plan-<ts>-*,
# jsa-gj-<date>-*), which are definitionally transient. Curated cross-session
# rooms are kept permanent by exact match (checked first).
PROPOSED_PREFIXES: List[Tuple[str, Tuple[str, int]]] = [
    ("wing_jsa/plan-", ("T2", 30)),
    ("wing_jsa/jsa-gj-", ("T2", 30)),
    ("wing_sca/", ("T2", 30)),  # forward-looking: sca has no drawers yet
]
PROPOSED_KEEP = {
    "wing_jsa/jsa-learnings",
    "wing_jsa/bug_bounty_methodology",
    "wing_jsa/vulnerability_research",
    "wing_sca/sca-learnings",
}

OVERSIZE_BYTES = 20_000
DEAD_TOKENS = ["jobz"]  # user-flagged defunct names; extend as the manifest reveals more

# Wings that are legitimately not skill-named (kept regardless of skill list).
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

LIVE_SKILLS = {p.name for p in (_ROOT / ".pi" / "skills").iterdir() if p.is_dir()}
LIVE_EXT = {p.name for p in (_ROOT / ".pi" / "extensions").iterdir() if p.is_dir()}


def proposed_classify(d: "arch.DrawerMeta") -> Tuple[str, int]:
    key = f"{d.wing}/{d.room}"
    if key in PROPOSED_KEEP:
        return ("T3", -1)
    for prefix, tt in PROPOSED_PREFIXES:
        if key.startswith(prefix):
            return tt
    return arch.classify_drawer(d)


def _archive_verdict(tier_ttl: Tuple[str, int], d: "arch.DrawerMeta") -> str:
    _, ttl = tier_ttl
    if ttl < 0:
        return "keep"
    days = arch.age_days(d.timestamp)
    if days is None:
        return "unknown"
    return "archive" if days > ttl else "keep"


def _dead_name(wing: str, room: str) -> str:
    """Return a reason string if this wing/room references a defunct thing, else ''."""
    key = f"{wing}/{room}".lower()
    for tok in DEAD_TOKENS:
        if tok in key:
            return f"name contains defunct token '{tok}'"
    m = re.match(r"wing_([a-z0-9-]+)$", wing)
    if m and wing not in _NON_SKILL_WINGS and not wing.startswith("wing_test-agent"):
        skill = m.group(1)
        if skill not in LIVE_SKILLS:
            return f"wing '{wing}' names a non-live skill '{skill}'"
    m2 = re.match(r"skills/([a-z0-9]+)-", room)
    if m2 and m2.group(1) not in LIVE_SKILLS:
        return f"room '{room}' names a non-live skill '{m2.group(1)}'"
    return ""


def _is_test(wing: str, room: str, content: str) -> bool:
    if wing.startswith("wing_test-agent"):
        return True
    if room.startswith("e2e") or "test-" in room or room.endswith("-test"):
        return True
    if wing == "penny" and room == "signals" and ("Multi test" in content or "multi1_" in content):
        return True
    return False


def main() -> int:
    metas = arch._fetch_all_drawers(tool_list_drawers)
    total = len(metas)

    wings: Dict[str, Dict[str, int]] = defaultdict(lambda: {"count": 0, "bytes": 0})
    rooms: Dict[str, Dict[str, object]] = {}
    manifest: Dict[str, List[dict]] = {
        "test_artifacts": [],
        "dead_name": [],
        "oversized": [],
        "content_mentions_dead": [],
    }
    cur_roll = defaultdict(int)
    prop_roll = defaultdict(int)
    newly_decayable = {"count": 0, "bytes": 0}

    for d in metas:
        size = len(d.content or "")
        wings[d.wing]["count"] += 1
        wings[d.wing]["bytes"] += size

        rk = f"{d.wing}/{d.room}"
        r = rooms.setdefault(rk, {"count": 0, "bytes": 0, "cur": "", "prop": ""})
        r["count"] += 1  # type: ignore[operator]
        r["bytes"] += size  # type: ignore[operator]

        cur = _archive_verdict(arch.classify_drawer(d), d)
        prop = _archive_verdict(proposed_classify(d), d)
        r["cur"], r["prop"] = cur, prop
        cur_roll[cur] += 1
        prop_roll[prop] += 1
        if cur != "archive" and prop == "archive":
            newly_decayable["count"] += 1
            newly_decayable["bytes"] += size

        entry = {"id": d.drawer_id, "wing": d.wing, "room": d.room, "bytes": size}
        if _is_test(d.wing, d.room, d.content or ""):
            manifest["test_artifacts"].append(entry)
        dn = _dead_name(d.wing, d.room)
        if dn:
            manifest["dead_name"].append({**entry, "reason": dn})
        if size > OVERSIZE_BYTES:
            manifest["oversized"].append(entry)
        if any(tok in (d.content or "").lower() for tok in DEAD_TOKENS) and not dn:
            manifest["content_mentions_dead"].append(entry)

    # ── Report ────────────────────────────────────────────────────────────
    print(f"# MemPalace Audit (READ-ONLY) — {datetime.now(timezone.utc).date()}")
    print(f"\nTotal drawers: {total}\n")

    print("## Wings")
    for w, s in sorted(wings.items(), key=lambda x: -x[1]["count"]):
        print(f"  {w:<34} {s['count']:>5} drawers  {s['bytes'] / 1024:>9.1f} KB")

    print("\n## Top 25 rooms (current → proposed archiver verdict)")
    top = sorted(rooms.items(), key=lambda x: -x[1]["count"])[:25]  # type: ignore[index]
    for rk, s in top:
        flag = "  ⇒ NEWLY DECAYABLE" if s["cur"] != "archive" and s["prop"] == "archive" else ""
        print(
            f"  {rk:<52} {s['count']:>5}  {s['bytes'] / 1024:>8.1f}KB  "
            f"{s['cur']:>7} → {s['prop']:<7}{flag}"
        )

    print("\n## Archive-verdict rollup")
    print(f"  CURRENT : keep={cur_roll['keep']}  archive={cur_roll['archive']}  unknown={cur_roll['unknown']}")
    print(f"  PROPOSED: keep={prop_roll['keep']}  archive={prop_roll['archive']}  unknown={prop_roll['unknown']}")
    print(
        f"  ⇒ Proposed rules newly age out {newly_decayable['count']} drawers "
        f"({newly_decayable['bytes'] / 1024:.1f} KB) that today are kept forever."
    )

    print("\n## Flagged for the human gate")
    for cat in ("test_artifacts", "dead_name", "oversized", "content_mentions_dead"):
        items = manifest[cat]
        tb = sum(i["bytes"] for i in items)
        print(f"  {cat:<22} {len(items):>4} drawers  {tb / 1024:>8.1f} KB")
        for i in items[:5]:
            extra = f"  ({i['reason']})" if "reason" in i else ""
            print(f"      - {i['wing']}/{i['room']}  [{i['id'][:40]}]{extra}")
        if len(items) > 5:
            print(f"      … +{len(items) - 5} more (see manifest)")

    out = Path("/tmp") / f"mempalace_audit_{datetime.now(timezone.utc).date()}.json"
    out.write_text(
        json.dumps(
            {
                "generated": datetime.now(timezone.utc).isoformat(),
                "total_drawers": total,
                "wings": wings,
                "rooms": {k: v for k, v in rooms.items()},
                "rollup": {"current": dict(cur_roll), "proposed": dict(prop_roll)},
                "newly_decayable": newly_decayable,
                "proposed_prefixes": PROPOSED_PREFIXES,
                "proposed_keep": sorted(PROPOSED_KEEP),
                "flagged": manifest,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nFull manifest → {out}")
    print("READ-ONLY: nothing was modified. Phase 2 (deletion) is separate and human-gated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
