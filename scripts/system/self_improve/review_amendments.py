#!/usr/bin/env python3
"""Review and apply self-improvement amendments — the missing half of the loop.

The compression loop proposes amendments into penny/system_amendments, and
session start surfaces the PENDING ones — but until this CLI existed nothing
could transition a proposal out of PENDING, so amendment_applier was dead code
and every proposal rotted. Lifecycle:

    PENDING --approve--> APPROVED --apply--> APPLIED (applied_date stamped)
    PENDING --reject--> REJECTED

Usage (from the repo root):
    review_amendments.py list [--all]      # pending only, or every amendment
    review_amendments.py show <id>
    review_amendments.py approve <id>
    review_amendments.py reject <id>
    review_amendments.py apply <id> [--no-commit]

Drawer mechanics: amendments are stored as 'amendment_id: <id>' + indented
JSON. A status flip rewrites the drawer by adding the NEW drawer first and
deleting the old one second (with skip_duplicate_check — the semantic
duplicate guard would otherwise reject the near-identical re-add). Add-first
means a crash mid-flip leaves a transient duplicate that _find refuses
loudly, never a lost record; delete-first left a window where Ctrl-C or OOM
during the add (embedding-model cold start) destroyed the only copy.

The applied_date stamped here is the cut point the efficacy eval
(quality.amendment_efficacy) uses to compare the domain's mismatch rate
before vs after — the check that turns "we changed a prompt" into "we know
whether it helped".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[2]
_BRIDGE_DIR = _REPO_ROOT / "scripts" / "system" / "bridge"
for p in (str(_BRIDGE_DIR), str(_HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from memory_bridge import (  # noqa: E402
    _CHUNK_THRESHOLD,
    tool_add_drawer,
    tool_delete_drawer,
    tool_list_drawers,
)
from amendment_applier import _concrete_diff_error  # noqa: E402

ROOM = "system_amendments"
WING = "penny"


def _load_all() -> List[Tuple[str, Dict[str, Any]]]:
    """Every amendment as (drawer_id, record). Exhaustive listing, NOT
    smart_search — similarity thresholds silently drop records."""
    result = tool_list_drawers(
        {"wing": WING, "room": ROOM, "limit": 10000, "include_content": True}
    )
    out: List[Tuple[str, Dict[str, Any]]] = []
    for drawer in result.get("drawers", []) if result.get("success") else []:
        record = _parse(drawer.get("content") or "")
        if record is not None:
            out.append((drawer["id"], record))
    return out


def _parse(text: str) -> Optional[Dict[str, Any]]:
    """Parse 'amendment_id: <id>\\n<JSON>' (or bare-JSON) drawer content."""
    lines = text.splitlines()
    if lines and lines[0].startswith("amendment_id:"):
        body = "\n".join(lines[1:])
    else:
        body = text
    try:
        record = json.loads(body)
    except json.JSONDecodeError:
        return None
    return record if isinstance(record, dict) and record.get("amendment_id") else None


def _render(record: Dict[str, Any]) -> str:
    """The exact storage shape every reader parses — do not change."""
    return f"amendment_id: {record['amendment_id']}\n" + json.dumps(record, indent=2)


def _find(amendment_id: str) -> Tuple[str, Dict[str, Any]]:
    matches = [(d, r) for d, r in _load_all() if r.get("amendment_id") == amendment_id]
    if not matches:
        raise SystemExit(f"no amendment with id {amendment_id!r} (try: list --all)")
    if len(matches) > 1:
        raise SystemExit(
            f"{len(matches)} drawers share amendment_id {amendment_id!r} — "
            "resolve the duplicate drawers manually before reviewing"
        )
    return matches[0]


def _add(content: str) -> Dict[str, Any]:
    return tool_add_drawer(
        {
            "wing": WING,
            "room": ROOM,
            "content": content,
            "added_by": "review_amendments",
            "source_file": "scripts/system/self_improve/review_amendments.py",
            "type": "amendment",
            "skip_duplicate_check": True,
        }
    )


def _rewrite(drawer_id: str, original: Dict[str, Any], updated: Dict[str, Any]) -> None:
    """Replace a drawer's content: add the new drawer FIRST, delete the old
    one second. A crash between the two leaves a duplicate amendment_id that
    _find refuses loudly — recoverable, unlike the delete-first ordering
    whose crash window destroyed the only copy of the record."""
    new_content = _render(updated)
    if len(new_content) > _CHUNK_THRESHOLD:
        raise SystemExit(
            f"rendered amendment is {len(new_content)} chars, over the "
            f"{_CHUNK_THRESHOLD}-char chunking threshold — a chunked drawer is "
            "unreadable by every amendment parser. Trim the record first."
        )
    added = _add(new_content)
    if not (isinstance(added, dict) and added.get("success")):
        raise SystemExit(f"add of updated record failed ({added}); original drawer untouched")
    deleted = tool_delete_drawer({"drawer_id": drawer_id})
    if not deleted.get("success"):
        raise SystemExit(
            f"updated drawer written but old drawer {drawer_id} could not be "
            f"deleted ({deleted.get('error')}); two drawers now share "
            f"amendment_id {updated.get('amendment_id')!r} — delete {drawer_id} manually"
        )


def _stamp(record: Dict[str, Any], status: str, date_field: str) -> Dict[str, Any]:
    record = dict(record)
    record["status"] = status
    record[date_field] = datetime.now(timezone.utc).isoformat()
    return record


# Statuses that still need a human step: PENDING (review it) or APPROVED (apply
# it). These stay visible so approve-now-apply-later doesn't lose track of a
# proposal. Resolved statuses (APPLIED/REJECTED) drop off and age out via the
# tiered archiver.
_ACTIONABLE = ("PENDING", "APPROVED")


def cmd_list(show_all: bool) -> int:
    rows = _load_all()
    if not show_all:
        rows = [(d, r) for d, r in rows if r.get("status") in _ACTIONABLE]
    if not rows:
        print("no amendments" + ("" if show_all else " to act on"))
        return 0
    for _, r in sorted(rows, key=lambda x: str(x[1].get("proposed_date", ""))):
        changes = r.get("changes", [])
        rationale = changes[0].get("rationale", "") if changes else ""
        print(
            f"{r['amendment_id']:<38} {r.get('status', '?'):<9} "
            f"risk={r.get('risk', '?'):<7} {r.get('target_file', '?')}"
        )
        if rationale:
            print(f"    {rationale[:120]}")
    return 0


def _indent(text: str, prefix: str = "      ") -> str:
    return "\n".join(prefix + line for line in text.splitlines())


def cmd_show(amendment_id: str) -> int:
    _, record = _find(amendment_id)
    print(json.dumps(record, indent=2))
    changes = record.get("changes", [])
    if changes:
        # A readable render of the EXACT edit approval authorizes Penny to apply
        # — informed approval is the whole safety basis for auto-apply.
        print("\n--- Proposed diff (what approval authorizes Penny to apply) ---")
        print(f"target: {record.get('target_file', '?')}")
        for i, c in enumerate(changes, 1):
            action = (c.get("action") or "ADD").upper()
            print(f"\n[{i}] {action}")
            old = c.get("old_text", "") or ""
            new = c.get("new_text", "") or ""
            if old:
                print("  - remove:\n" + _indent(old))
            if new:
                print("  + add:\n" + _indent(new))
            err = _concrete_diff_error(c)
            if err:
                print(f"  ⚠ NOT APPLIABLE: {err}")
    return 0


def cmd_approve(amendment_id: str) -> int:
    drawer_id, record = _find(amendment_id)
    if record.get("status") != "PENDING":
        raise SystemExit(
            f"only PENDING amendments can be approved (status: {record.get('status')})"
        )
    # Approval authorizes auto-apply of the EXACT diff, so it must approve a
    # CONCRETE change. An empty/vague diff can't be applied and would dangle at
    # APPROVED forever (the legacy CODE_CHANGE amendments' failure mode).
    changes = record.get("changes", [])
    if not changes:
        raise SystemExit(f"cannot approve {amendment_id}: it has no changes")
    diff_errors = [e for c in changes if (e := _concrete_diff_error(c))]
    if diff_errors:
        raise SystemExit(
            f"cannot approve {amendment_id}: no concrete diff to apply "
            f"({'; '.join(diff_errors)}). Author verbatim old_text/new_text, or reject it."
        )
    _rewrite(drawer_id, record, _stamp(record, "APPROVED", "reviewed_date"))
    print(f"{amendment_id} -> APPROVED (apply with: review_amendments.py apply {amendment_id})")
    return 0


def cmd_reject(amendment_id: str) -> int:
    drawer_id, record = _find(amendment_id)
    # A human may reject a proposal they are still reviewing (PENDING) OR one they
    # previously approved but changed their mind on / can no longer apply
    # (APPROVED). Without the APPROVED path an approved-but-unappliable amendment
    # has no terminal exit and re-surfaces in the session brief forever.
    if record.get("status") not in ("PENDING", "APPROVED"):
        raise SystemExit(
            f"only PENDING or APPROVED amendments can be rejected (status: {record.get('status')})"
        )
    _rewrite(drawer_id, record, _stamp(record, "REJECTED", "reviewed_date"))
    print(f"{amendment_id} -> REJECTED")
    return 0


def cmd_apply(amendment_id: str, git_commit: bool) -> int:
    drawer_id, record = _find(amendment_id)
    if record.get("status") != "APPROVED":
        raise SystemExit(
            f"only APPROVED amendments can be applied (status: {record.get('status')}); "
            "approve first"
        )
    os.chdir(_REPO_ROOT)  # applier resolves repo-relative target_file paths
    from amendment_applier import apply_amendment  # noqa: E402

    result = apply_amendment(record, git_commit=git_commit)
    if not result.get("success"):
        print(f"APPLY FAILED: {result.get('error')}")
        return 1
    _rewrite(drawer_id, record, _stamp(record, "APPLIED", "applied_date"))
    committed = "committed" if result.get("committed") else "not committed (--no-commit)"
    print(
        f"{amendment_id} -> APPLIED ({committed}). Efficacy will be measured by "
        "quality.amendment_efficacy once 30d of post-apply outcomes accrue."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_list = sub.add_parser(
        "list", help="list amendments needing action — pending or approved (--all for every status)"
    )
    p_list.add_argument("--all", action="store_true", dest="show_all")
    for name in ("show", "approve", "reject"):
        sub.add_parser(name).add_argument("amendment_id")
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("amendment_id")
    p_apply.add_argument("--no-commit", action="store_true")
    args = parser.parse_args()

    if args.command == "list":
        return cmd_list(args.show_all)
    if args.command == "show":
        return cmd_show(args.amendment_id)
    if args.command == "approve":
        return cmd_approve(args.amendment_id)
    if args.command == "reject":
        return cmd_reject(args.amendment_id)
    if args.command == "apply":
        return cmd_apply(args.amendment_id, git_commit=not args.no_commit)
    return 2


if __name__ == "__main__":
    sys.exit(main())
