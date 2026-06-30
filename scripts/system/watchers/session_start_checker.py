"""
Session-Start Signal Checker

Checks for pending signals at the beginning of each Penny session.
CRITICAL signals are surfaced immediately; INFO signals are noted briefly.

Usage:
    source .venv/bin/activate
    python scripts/system/watchers/session_start_checker.py [session_id]

Returns JSON:
    {
      "generated": ["signal_id", ...],
      "pending": {
        "critical": [{...}, ...],
        "info": [{...}, ...]
      },
      "presentation": "formatted markdown string"
    }
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Resolve project root relative to this script (scripts/system/watchers/ → project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BRIDGE_DIR = _PROJECT_ROOT / "scripts" / "system" / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

from signal_generators import (  # noqa: E402
    run_all_metric_watchers,
    _now,
    _iso,
)
from watcher_logger import info, warn, error, exception, debug  # noqa: E402
from memory_bridge import tool_smart_search  # noqa: E402


def get_pending_signals(limit: int = 10, session_id: str = "") -> dict[str, list[dict]]:
    """
    Retrieve pending signals for presentation at session start.

    Returns dict with:
    - critical: list of CRITICAL signals (sorted by timestamp desc)
    - info: list of INFO signals (sorted by timestamp desc)
    """
    debug("session_start_checker", "Fetching pending signals", session_id=session_id, data={"limit": limit})
    search = tool_smart_search({
        "query": "pending signals PENDING",
        "wing": "penny",
        "room": "signals",
        "limit": limit * 2,
        "include_full": True,
    })
    results = search.get("results", [])

    critical: list[dict] = []
    info_signals: list[dict] = []

    for r in results:
        text = r.get("text", "")
        sig = _parse_signal_text(text)
        if not sig or sig.get("status") != "PENDING":
            continue
        entry = {
            **sig,
            "_drawer_id": r.get("id"),  # preserve for acknowledgment
        }
        if sig.get("priority") == "CRITICAL":
            critical.append(entry)
        else:
            info_signals.append(entry)

    critical.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    info_signals.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    info(
        "session_start_checker",
        f"Pending signals retrieved: {len(critical)} critical, {len(info_signals)} info",
        session_id=session_id,
        data={"critical_count": len(critical), "info_count": len(info_signals)},
    )

    return {
        "critical": critical[:limit],
        "info": info_signals[:limit],
    }


def _parse_signal_text(text: str) -> dict[str, Any] | None:
    """Extract the JSON signal object from a drawer text."""
    lines = text.splitlines()
    # First line is 'signal_id: <id>', rest is JSON
    if not lines:
        return None
    try:
        json_blob = "\n".join(lines[1:])
        return json.loads(json_blob)
    except json.JSONDecodeError:
        # Fallback: try to treat entire text as JSON
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None


def get_pending_amendments(limit: int = 5, session_id: str = "") -> list[dict]:
    """Retrieve pending amendments from mempalace for user review.

    Returns list of PENDING amendments sorted by proposed_date desc.
    """
    debug("session_start_checker", "Fetching pending amendments", session_id=session_id, data={"limit": limit})
    search = tool_smart_search({
        "query": "PENDING amendment",
        "wing": "penny",
        "room": "system_amendments",
        "limit": limit * 2,
        "include_full": True,
    })
    results = search.get("results", [])

    amendments = []
    for r in results:
        text = r.get("text", "")
        try:
            # Try to parse JSON amendment from text
            if text.startswith("amendment_id:"):
                json_blob = "\n".join(text.splitlines()[1:])
                amend = json.loads(json_blob)
            else:
                amend = json.loads(text)
            if amend.get("status") == "PENDING":
                amendments.append(amend)
        except (json.JSONDecodeError, AttributeError):
            continue

    amendments.sort(key=lambda x: x.get("proposed_date", ""), reverse=True)
    info(
        "session_start_checker",
        f"Pending amendments retrieved: {len(amendments)}",
        session_id=session_id,
        data={"amendment_count": len(amendments)},
    )
    return amendments[:limit]


def get_weekly_digest(session_id: str = "") -> dict[str, Any] | None:
    """Retrieve digest for current calendar week, if exists."""
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc)
    # ISO week start (Monday)
    week_start = today - __import__("datetime").timedelta(days=today.weekday())
    week_str = week_start.strftime("%Y-%m-%d")

    debug("session_start_checker", f"Fetching weekly digest for {week_str}", session_id=session_id)
    search = tool_smart_search({
        "query": f"digest_{week_str}",
        "wing": "penny",
        "room": "digests",
        "limit": 2,
        "include_full": True,
    })
    results = search.get("results", [])
    if not results:
        debug("session_start_checker", "No weekly digest found", session_id=session_id)
        return None

    try:
        text = results[0].get("text", "")
        lines = text.splitlines()
        if lines and lines[0].startswith("digest_id:"):
            json_blob = "\n".join(lines[1:])
        else:
            json_blob = text
        digest = json.loads(json_blob)
        info(
            "session_start_checker",
            "Weekly digest retrieved",
            session_id=session_id,
            data={"week": digest.get("week_start"), "has_attention": bool(digest.get("attention_flags"))},
        )
        return digest
    except (json.JSONDecodeError, Exception):
        warn("session_start_checker", "Failed to parse weekly digest", session_id=session_id)
        return None


def format_signal_presentation(pending: dict[str, list[dict]], amendments: list[dict] | None = None, digest: dict[str, Any] | None = None) -> str:
    """
    Format pending signals for presentation to user.
    CRITICAL signals get full context; INFO signals get one-line mentions.
    """
    lines: list[str] = []

    critical = pending.get("critical", [])
    info = pending.get("info", [])

    if critical:
        lines.append("## ⚠️ Attention Required")
        for sig in critical:
            lines.append(f"\n- **{sig['title']}**")
            if sig.get("context"):
                lines.append(f"  {sig['context']}")
            if sig.get("suggested_action"):
                lines.append(f"  → *{sig['suggested_action']}*")

    if info:
        lines.append("\n## 📋 FYI")
        for sig in info:
            lines.append(f"- {sig['title']}")

    # Amendments section
    if amendments:
        lines.append("\n## 📝 Pending Amendments")
        lines.append("The following self-improvement proposals await your review:")
        for a in amendments:
            lines.append(f"\n- **{a['amendment_id']}** → `{a['target_file'].split('/')[-1]}` (Risk: {a.get('risk', '?')})")
            lines.append(f"  Trigger: {a.get('trigger', 'N/A')}")
            if a.get("changes"):
                change = a["changes"][0]
                rationale = change.get("rationale", "")
                if len(rationale) > 120:
                    rationale = rationale[:117] + "..."
                lines.append(f"  Rationale: {rationale}")

    # Weekly digest teaser
    if digest:
        has_attention = len(digest.get("attention_flags", [])) > 0
        if has_attention:
            lines.append("\n## 📊 Weekly Digest")
            outcomes = digest.get("outcomes", {})
            total = sum(outcomes.get(k, 0) for k in ("MATCH", "PARTIAL", "MISMATCH"))
            lines.append(f"- Decisions this week: {total}")
            for flag in digest["attention_flags"]:
                lines.append(f"- ⚠️ {flag['description']}")
            if digest.get("recommendations"):
                lines.append(f"- → {digest['recommendations'][0]}")
        else:
            # One-line teaser only
            lines.append(f"\n📊 Weekly Digest available — {digest.get('summary', {}).get('decisions', 0)} decisions this week")

    if not critical and not info and not amendments and not digest:
        lines.append("## No pending signals, amendments, or digest")

    return "\n".join(lines)


def check_and_generate_signals(session_id: str) -> list[str]:
    """
    Run all metric-based watchers and write signals to mempalace.
    Returns list of generated signal_ids.
    """
    return run_all_metric_watchers(session_id)


def main() -> None:
    session_id = sys.argv[1] if len(sys.argv) > 1 else f"session_{_iso(_now())}"
    info("session_start_checker", "Session start checker started", session_id=session_id)

    # Phase A: generate new signals from watcher logic
    try:
        generated = check_and_generate_signals(session_id)
    except Exception as exc:
        exception("session_start_checker", "Signal generation failed", exc, session_id=session_id)
        generated = []

    # Phase B: retrieve all pending signals (including previously generated ones)
    try:
        pending_signals = get_pending_signals(limit=10, session_id=session_id)
    except Exception as exc:
        exception("session_start_checker", "Failed to retrieve pending signals", exc, session_id=session_id)
        pending_signals = {"critical": [], "info": []}

    try:
        pending_amendments = get_pending_amendments(limit=5, session_id=session_id)
    except Exception as exc:
        exception("session_start_checker", "Failed to retrieve pending amendments", exc, session_id=session_id)
        pending_amendments = []

    try:
        weekly_digest = get_weekly_digest(session_id=session_id)
    except Exception as exc:
        exception("session_start_checker", "Failed to retrieve weekly digest", exc, session_id=session_id)
        weekly_digest = None

    # Phase C: format for presentation
    presentation = format_signal_presentation(pending_signals, pending_amendments, weekly_digest)

    output = {
        "session_id": session_id,
        "generated": generated,
        "pending": {
            "critical_count": len(pending_signals["critical"]),
            "info_count": len(pending_signals["info"]),
            "critical": [s["signal_id"] for s in pending_signals["critical"]],
            "info": [s["signal_id"] for s in pending_signals["info"]],
        },
        "amendments": {
            "count": len(pending_amendments),
            "ids": [a["amendment_id"] for a in pending_amendments],
        },
        "digest": {
            "available": weekly_digest is not None,
            "week": weekly_digest.get("week_start") if weekly_digest else None,
            "has_attention": bool(weekly_digest.get("attention_flags")) if weekly_digest else False,
        },
        "presentation": presentation,
    }

    info(
        "session_start_checker",
        "Session start checker finished",
        session_id=session_id,
        data={
            "generated_count": len(generated),
            "critical_count": output["pending"]["critical_count"],
            "info_count": output["pending"]["info_count"],
            "amendment_count": len(pending_amendments),
            "digest_available": output["digest"]["available"],
        },
    )
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
