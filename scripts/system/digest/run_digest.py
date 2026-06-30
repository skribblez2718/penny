#!/usr/bin/env python3
"""Weekly Digest Runner.

Collects outcomes, diary entries, pending signals, and amendment counts from
mempalace for the previous calendar week, builds a digest JSON, renders it to
markdown, stores it in penny/digests, and prints the markdown to stdout.

Intended to run from cron every Monday morning.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Resolve project root relative to this script (scripts/system/digest/ → project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BRIDGE_DIR = _PROJECT_ROOT / "scripts" / "system" / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

# Source .env so bridge modules can read palace / observability configuration.
_ENV_PATH = _PROJECT_ROOT / ".env"
if _ENV_PATH.exists():
    try:
        with open(_ENV_PATH, "r", encoding="utf-8") as env_file:
            for line in env_file:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass

_WATCHERS_DIR = _PROJECT_ROOT / "scripts" / "system" / "watchers"
if str(_WATCHERS_DIR) not in sys.path:
    sys.path.insert(0, str(_WATCHERS_DIR))

from generator import build_digest_json  # noqa: E402
from renderer import render_digest_markdown  # noqa: E402
from storage import store_digest  # noqa: E402
from watcher_logger import info, warn, error, exception  # noqa: E402
from memory_bridge import tool_smart_search  # noqa: E402

_DEFAULT_QUERY_LIMIT = 100


def _try_parse_json(text: str) -> Optional[Dict[str, Any]]:
    """Best-effort parse of a drawer text that may be JSON or JSON-with-header."""
    text = text.strip()
    if not text:
        return None

    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

    lines = text.splitlines()
    if len(lines) > 1:
        try:
            return json.loads("\n".join(lines[1:]))
        except json.JSONDecodeError:
            pass

    return None


def _parse_timestamp(text: str) -> Optional[datetime]:
    """Extract the first ISO-8601 timestamp from text, if any."""
    match = re.search(
        r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?)",
        text,
    )
    if not match:
        return None

    ts = match.group(1)
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"

    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def _parse_outcome_record(text: str) -> Optional[Dict[str, Any]]:
    """Parse an outcome drawer into a canonical dict."""
    parsed = _try_parse_json(text)
    if parsed is not None and isinstance(parsed, dict):
        if parsed.get("outcome") is None and parsed.get("delta_score") is not None:
            parsed["outcome"] = parsed["delta_score"]
        return parsed

    record: Dict[str, Any] = {}
    for field in (
        "decision_id",
        "outcome",
        "domain",
        "reason",
        "session_id",
        "confidence_at_action",
    ):
        pattern = rf"{field}:\s*(.*?)(?=\n\w+[\w_]*:\s|$)"
        match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
        if match:
            record[field] = match.group(1).strip()

    if record.get("outcome") is None:
        delta_match = re.search(r"delta_score:\s*(\S+)", text, re.IGNORECASE)
        if delta_match:
            record["outcome"] = delta_match.group(1).strip()

    return record if record else None


def _parse_record_payload(text: str) -> Optional[Dict[str, Any]]:
    """Parse a generic palace drawer that stores a JSON payload."""
    parsed = _try_parse_json(text)
    return parsed if isinstance(parsed, dict) else None


def get_last_week_range(today: Optional[date] = None) -> Tuple[str, str]:
    """Return ISO date strings for the previous Monday–Sunday week."""
    if today is None:
        today = datetime.now(timezone.utc).date()
    # today.weekday() is 0 on Monday. Roll back to the Monday of the prior week.
    week_start = today - timedelta(days=today.weekday() + 7)
    week_end = week_start + timedelta(days=6)
    return week_start.isoformat(), week_end.isoformat()


def fetch_weekly_outcomes(
    week_start: str,
    week_end: str,
    session_id: str,
    limit: int = _DEFAULT_QUERY_LIMIT,
) -> List[Dict[str, Any]]:
    """Query mempalace for outcome records filed during the digest week."""
    info(
        "digest_runner",
        f"Querying outcomes for week {week_start} to {week_end}",
        session_id=session_id,
    )

    try:
        result = tool_smart_search(
            {
                "query": "outcome decision_id session_id",
                "wing": "penny",
                "room": "outcomes",
                "limit": limit,
                "include_full": True,
                "context": f"Outcomes from {week_start} to {week_end}",
            }
        )
    except Exception as exc:
        exception("digest_runner", "Failed to query outcomes", exc, session_id=session_id)
        return []

    start = date.fromisoformat(week_start)
    end = date.fromisoformat(week_end)
    outcomes: List[Dict[str, Any]] = []

    for result in result.get("results", []):
        text = result.get("text", "")
        if not text:
            continue

        ts = _parse_timestamp(text)
        if ts is not None:
            rec_date = ts.date()
            if rec_date < start or rec_date > end:
                continue

        parsed = _parse_outcome_record(text)
        if parsed:
            outcomes.append(parsed)

    info(
        "digest_runner",
        f"Collected {len(outcomes)} outcomes for the digest week",
        session_id=session_id,
        data={"week_start": week_start, "week_end": week_end, "count": len(outcomes)},
    )
    return outcomes


def fetch_weekly_diary(
    week_start: str,
    week_end: str,
    session_id: str,
    limit: int = _DEFAULT_QUERY_LIMIT,
) -> List[Dict[str, Any]]:
    """Query mempalace for diary entries filed during the digest week."""
    info(
        "digest_runner",
        f"Querying diary for week {week_start} to {week_end}",
        session_id=session_id,
    )

    try:
        result = tool_smart_search(
            {
                "query": "diary entry",
                "wing": "penny",
                "room": "diary",
                "limit": limit,
                "include_full": True,
                "context": f"Diary entries from {week_start} to {week_end}",
            }
        )
    except Exception as exc:
        exception("digest_runner", "Failed to query diary", exc, session_id=session_id)
        return []

    start = date.fromisoformat(week_start)
    end = date.fromisoformat(week_end)
    entries: List[Dict[str, Any]] = []

    for result in result.get("results", []):
        text = result.get("text", "")
        if not text:
            continue

        ts = _parse_timestamp(text)
        if ts is not None:
            rec_date = ts.date()
            if rec_date < start or rec_date > end:
                continue

        entries.append({"text": text, "timestamp": ts.isoformat() if ts else ""})

    info(
        "digest_runner",
        f"Collected {len(entries)} diary entries for the digest week",
        session_id=session_id,
        data={"count": len(entries)},
    )
    return entries


def fetch_pending_signals(
    session_id: str,
    limit: int = _DEFAULT_QUERY_LIMIT,
) -> List[Dict[str, Any]]:
    """Query mempalace for currently pending signals."""
    info("digest_runner", "Querying pending signals", session_id=session_id)

    try:
        result = tool_smart_search(
            {
                "query": "PENDING signal",
                "wing": "penny",
                "room": "signals",
                "limit": limit,
                "include_full": True,
            }
        )
    except Exception as exc:
        exception("digest_runner", "Failed to query signals", exc, session_id=session_id)
        return []

    signals: List[Dict[str, Any]] = []
    for result in result.get("results", []):
        text = result.get("text", "")
        if not text:
            continue
        parsed = _parse_record_payload(text)
        if parsed and parsed.get("status") == "PENDING":
            signals.append(parsed)

    info(
        "digest_runner",
        f"Collected {len(signals)} pending signals",
        session_id=session_id,
        data={"count": len(signals)},
    )
    return signals


def fetch_amendment_counts(
    session_id: str,
    limit: int = 200,
) -> Dict[str, int]:
    """Query mempalace for amendment status counts."""
    info("digest_runner", "Querying amendment counts", session_id=session_id)

    try:
        result = tool_smart_search(
            {
                "query": "amendment status",
                "wing": "penny",
                "room": "system_amendments",
                "limit": limit,
                "include_full": True,
            }
        )
    except Exception as exc:
        exception("digest_runner", "Failed to query amendments", exc, session_id=session_id)
        return {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0}

    counts: Dict[str, int] = {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0}
    status_counts: Dict[str, int] = {}

    for result in result.get("results", []):
        text = result.get("text", "")
        if not text:
            continue
        parsed = _parse_record_payload(text)
        if not parsed:
            continue

        status = parsed.get("status", "UNKNOWN")
        status_counts[status] = status_counts.get(status, 0) + 1
        counts["proposed"] += 1

    counts["pending"] = status_counts.get("PENDING", 0)
    counts["approved"] = status_counts.get("APPROVED", 0)
    counts["rejected"] = status_counts.get("REJECTED", 0)

    info(
        "digest_runner",
        "Amendment counts collected",
        session_id=session_id,
        data=dict(counts),
    )
    return counts


def main() -> int:
    session_id = (
        sys.argv[1]
        if len(sys.argv) > 1
        else f"digest_{datetime.now(timezone.utc).isoformat()}"
    )
    info("digest_runner", "Digest runner started", session_id=session_id)

    try:
        week_start, week_end = get_last_week_range()
        info(
            "digest_runner",
            f"Generating digest for {week_start} to {week_end}",
            session_id=session_id,
        )

        outcomes = fetch_weekly_outcomes(week_start, week_end, session_id)
        diary = fetch_weekly_diary(week_start, week_end, session_id)
        signals = fetch_pending_signals(session_id)
        amendments = fetch_amendment_counts(session_id)

        digest = build_digest_json(
            outcomes=outcomes,
            diary=diary,
            week_start=week_start,
            week_end=week_end,
            amendments=amendments,
            signals=signals,
        )

        markdown = render_digest_markdown(digest)
        store_result = store_digest(digest)

        if store_result.get("success"):
            info(
                "digest_runner",
                "Digest stored in mempalace",
                session_id=session_id,
                data={"drawer_id": store_result.get("drawer_id"), "digest_id": digest.get("digest_id")},
            )
        else:
            error(
                "digest_runner",
                "Failed to store digest",
                session_id=session_id,
                data={"error": store_result.get("error"), "digest_id": digest.get("digest_id")},
            )

        print(markdown)
        info(
            "digest_runner",
            "Digest runner finished",
            session_id=session_id,
            data={"digest_id": digest.get("digest_id"), "digest_length": len(markdown)},
        )
        return 0

    except Exception as exc:
        exception("digest_runner", "Digest runner failed", exc, session_id=session_id)
        return 1


if __name__ == "__main__":
    sys.exit(main())
