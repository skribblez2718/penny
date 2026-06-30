#!/usr/bin/env python3
"""Self-Improvement Compression Loop Runner.

Queries mempalace for recent outcomes, runs the compression loop to detect
recurring patterns, and stores proposed amendments in penny/system_amendments.

Intended to run from cron once per day.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Resolve project root relative to this script (scripts/system/self_improve/ → project root)
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

from compression_loop import run_compression_loop  # noqa: E402
from watcher_logger import info, warn, error, exception  # noqa: E402
from memory_bridge import tool_smart_search, tool_add_drawer  # noqa: E402

# Outcome records from the last N days.
_DEFAULT_WINDOW_DAYS = 7
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
    if len(lines) > 1 and lines[0].rstrip().endswith(":") is False:
        # Common palace format: first line is an ID header, remainder is JSON.
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


def _parse_outcome_record(text: str) -> Dict[str, Any]:
    """Parse an outcome drawer into a dict with canonical fields."""
    parsed = _try_parse_json(text)
    if parsed is not None and isinstance(parsed, dict):
        # Some producers store the verdict as `delta_score` instead of `outcome`.
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

    return record


def _parse_amendment_record(text: str) -> Optional[Dict[str, Any]]:
    """Parse an amendment drawer into its JSON payload."""
    parsed = _try_parse_json(text)
    if isinstance(parsed, dict):
        return parsed
    return None


def fetch_recent_outcomes(
    session_id: str,
    window_days: int = _DEFAULT_WINDOW_DAYS,
    limit: int = _DEFAULT_QUERY_LIMIT,
) -> List[Dict[str, Any]]:
    """Query mempalace for recent outcome records."""
    info(
        "compression_runner",
        "Querying recent outcomes",
        session_id=session_id,
        data={"window_days": window_days, "limit": limit},
    )

    try:
        result = tool_smart_search(
            {
                "query": "outcome decision_id reason domain session_id",
                "wing": "penny",
                "room": "outcomes",
                "limit": limit,
                "include_full": True,
                "context": f"Recent outcomes within last {window_days} days",
            }
        )
    except Exception as exc:
        exception("compression_runner", "Failed to query outcomes", exc, session_id=session_id)
        return []

    results = result.get("results", [])
    if not results:
        warn("compression_runner", "No outcome records returned from mempalace", session_id=session_id)
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    outcomes: List[Dict[str, Any]] = []
    skipped = 0

    for result in results:
        text = result.get("text", "")
        if not text:
            continue

        ts = _parse_timestamp(text)
        if ts is not None and ts < cutoff:
            skipped += 1
            continue

        parsed = _parse_outcome_record(text)
        if parsed.get("outcome") or parsed.get("decision_id"):
            outcomes.append(parsed)

    info(
        "compression_runner",
        f"Parsed {len(outcomes)} recent outcome records ({skipped} outside window)",
        session_id=session_id,
        data={"raw_results": len(results), "parsed": len(outcomes), "skipped": skipped},
    )
    return outcomes


def fetch_previous_amendments(
    session_id: str,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """Load existing amendments so the compression loop can deduplicate triggers."""
    try:
        result = tool_smart_search(
            {
                "query": "amendment",
                "wing": "penny",
                "room": "system_amendments",
                "limit": limit,
                "include_full": True,
            }
        )
    except Exception as exc:
        exception(
            "compression_runner",
            "Failed to query previous amendments; continuing without deduplication",
            exc,
            session_id=session_id,
        )
        return []

    amendments: List[Dict[str, Any]] = []
    for result in result.get("results", []):
        text = result.get("text", "")
        if not text:
            continue
        parsed = _parse_amendment_record(text)
        if parsed:
            amendments.append(parsed)

    return amendments


def store_amendment(amendment: Dict[str, Any], session_id: str) -> bool:
    """Persist a single amendment to penny/system_amendments."""
    amendment_id = amendment.get("amendment_id", "unknown")
    content = f"amendment_id: {amendment_id}\n" + json.dumps(amendment, indent=2)

    try:
        result = tool_add_drawer(
            {
                "wing": "penny",
                "room": "system_amendments",
                "content": content,
                "source_file": "scripts/system/self_improve/run_compression.py",
            }
        )
    except Exception as exc:
        exception(
            "compression_runner",
            f"Exception storing amendment {amendment_id}",
            exc,
            session_id=session_id,
        )
        return False

    if result.get("success"):
        info(
            "compression_runner",
            f"Stored amendment {amendment_id}",
            session_id=session_id,
            data={"drawer_id": result.get("drawer_id")},
        )
        return True

    if result.get("reason") == "duplicate":
        warn(
            "compression_runner",
            f"Amendment {amendment_id} is a duplicate; skipped",
            session_id=session_id,
        )
        return False

    error(
        "compression_runner",
        f"Failed to store amendment {amendment_id}",
        session_id=session_id,
        data={"result": result},
    )
    return False


def main() -> int:
    session_id = (
        sys.argv[1]
        if len(sys.argv) > 1
        else f"compression_{datetime.now(timezone.utc).isoformat()}"
    )
    info("compression_runner", "Compression runner started", session_id=session_id)

    try:
        outcomes = fetch_recent_outcomes(session_id)
        if not outcomes:
            info(
                "compression_runner",
                "No recent outcomes to compress; exiting cleanly",
                session_id=session_id,
            )
            print(json.dumps({"amendments_created": 0, "session_id": session_id}))
            return 0

        previous_amendments = fetch_previous_amendments(session_id)
        amendments = run_compression_loop(outcomes, previous_amendments=previous_amendments)

        if not amendments:
            info(
                "compression_runner",
                "No recurring patterns detected; no amendments generated",
                session_id=session_id,
            )
            print(json.dumps({"amendments_created": 0, "session_id": session_id}))
            return 0

        created = 0
        for amendment in amendments:
            if store_amendment(amendment, session_id):
                created += 1

        info(
            "compression_runner",
            "Compression runner finished",
            session_id=session_id,
            data={
                "amendments_created": created,
                "amendments_generated": len(amendments),
            },
        )
        print(
            json.dumps(
                {
                    "amendments_created": created,
                    "amendments_generated": len(amendments),
                    "session_id": session_id,
                }
            )
        )
        return 0

    except Exception as exc:
        exception("compression_runner", "Compression runner failed", exc, session_id=session_id)
        return 1


if __name__ == "__main__":
    sys.exit(main())
