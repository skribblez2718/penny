#!/usr/bin/env python3
"""One-time MemPalace cleanup — Phase 3 of the Item-5 memory cleanup.

Reclaims the accreted bulk that decay rules alone won't clear promptly (most of
it is < the 30d TTL). Age-INDEPENDENT, but SAFE:

  * DRY-RUN by default — prints exactly what it would delete, deletes nothing.
    Pass --execute to act.
  * Every deleted drawer is first written to grep-able JSONL cold storage
    (.mempalace/archive/...) — reusing the archiver's own cold-archive path — so
    nothing is ever truly lost.
  * Categorization is imported from mempalace_audit.py so the audit and the
    cleanup can never disagree.

Approved delete categories (2026-07-09):
  - transient JSA scratch      wing_jsa/{plan-*, jsa-gj-*}  (keeps jsa-learnings,
                               bug_bounty_methodology, vulnerability_research)
  - oversized raw transcripts  penny/technical drawers > 20 KB (one-time legacy
                               import; no active writer)
  - dead-name                  hackerone + any non-live skill/extension room/wing
  - stray agent-name wings     echo / piper / ring_jsa / skills
  - test artifacts             wing_test-agent-*, e2e/test rooms, "Multi test" signals

`jobz` content mentions are deliberately KEPT (legit ports from the archive).

    .venv/bin/python scripts/system/maintenance/mempalace_cleanup.py            # dry-run
    .venv/bin/python scripts/system/maintenance/mempalace_cleanup.py --execute  # act
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List

_HERE = Path(__file__).resolve()
_ROOT = _HERE.parents[3]
for _p in (
    _HERE.parent,  # mempalace_audit
    _ROOT / "scripts" / "system" / "tiered_memory",
    _ROOT / "scripts" / "system" / "bridge",
):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import archiver as arch  # noqa: E402
from memory_bridge import tool_list_drawers, tool_delete_drawer  # noqa: E402
from mempalace_audit import OVERSIZE_BYTES, _dead_name, _is_test  # noqa: E402

STRAY_WINGS = {"echo", "piper", "ring_jsa", "skills"}


def delete_reason(d: "arch.DrawerMeta") -> str:
    """Non-empty reason string ⇒ this drawer is a delete candidate."""
    wing, room, content = d.wing, d.room, (d.content or "")
    if _is_test(wing, room, content):
        return "test artifact"
    dn = _dead_name(wing, room)
    if dn:
        return f"dead-name: {dn}"
    if wing in STRAY_WINGS:
        return f"stray agent-name wing '{wing}'"
    if wing == "wing_jsa" and (room.startswith("plan-") or room.startswith("jsa-gj-")):
        return "transient JSA scratch"
    if wing == "penny" and room == "technical" and len(content) > OVERSIZE_BYTES:
        return "oversized raw transcript"
    return ""


def _palace_path() -> str:
    try:
        from memory_bridge import _config as _mp_config  # noqa: E402

        return str(_mp_config.palace_path)
    except Exception:
        return os.environ.get("MEMPALACE_PATH") or str(_ROOT / ".mempalace")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--execute", action="store_true", help="actually delete (default: dry-run)")
    args = ap.parse_args()

    metas = arch._fetch_all_drawers(tool_list_drawers)
    to_delete: List["arch.DrawerMeta"] = []
    by_reason: Dict[str, Dict[str, int]] = defaultdict(lambda: {"count": 0, "bytes": 0})
    for d in metas:
        reason = delete_reason(d)
        if not reason:
            continue
        cat = reason.split(":")[0]
        by_reason[cat]["count"] += 1
        by_reason[cat]["bytes"] += len(d.content or "")
        to_delete.append(d)

    total = len(metas)
    del_bytes = sum(len(d.content or "") for d in to_delete)
    mode = "EXECUTE" if args.execute else "DRY-RUN"
    print(f"# MemPalace cleanup — {mode}")
    print(f"\nPalace total: {total} drawers")
    print(f"Delete candidates: {len(to_delete)} drawers ({del_bytes / 1024:.1f} KB)")
    print(f"Keep: {total - len(to_delete)} drawers\n")
    print("## By category")
    for cat, s in sorted(by_reason.items(), key=lambda x: -x[1]["bytes"]):
        print(f"  {cat:<28} {s['count']:>5} drawers  {s['bytes'] / 1024:>9.1f} KB")

    # Show the room-level breakdown so a human can eyeball it before --execute.
    per_room: Dict[str, int] = defaultdict(int)
    for d in to_delete:
        per_room[f"{d.wing}/{d.room}"] += 1
    print("\n## Rooms affected (top 20 by drawer count)")
    for rk, c in sorted(per_room.items(), key=lambda x: -x[1])[:20]:
        print(f"  {rk:<56} {c:>5}")

    if not args.execute:
        print("\nDRY-RUN: nothing deleted. Re-run with --execute (after a backup) to act.")
        return 0

    # ── EXECUTE ───────────────────────────────────────────────────────────
    archive_root = os.path.join(_palace_path(), "archive")
    cold = arch._make_jsonl_archiver(archive_root)

    def deleter(drawer_id: str) -> bool:
        r = tool_delete_drawer({"drawer_id": drawer_id})
        return bool(r.get("success")) if isinstance(r, dict) else False

    print(f"\nCold-archiving to {archive_root} then deleting {len(to_delete)} drawers ...")
    stats = arch.archive_drawers(to_delete, deleter, archiver=cold)
    print(f"Deleted: {stats['deleted']}  Cold-archived: {stats['archived']}  Failed: {stats['failed']}")
    return 0 if stats["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
