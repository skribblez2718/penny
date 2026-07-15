#!/usr/bin/env python3
"""Self-Improvement Compression Loop Runner.

Queries mempalace for recent outcomes, runs the compression loop to detect
recurring patterns, and stores proposed amendments in penny/system_amendments.

Intended to run from cron once per day.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
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

# #18: read outcomes STRUCTURALLY from the outcome ledger, not via a fuzzy semantic
# search + regex-prose parsing.
_LEDGER_DIR = _PROJECT_ROOT / "scripts" / "system" / "outcome_ledger"
if str(_LEDGER_DIR) not in sys.path:
    sys.path.insert(0, str(_LEDGER_DIR))

from compression_loop import run_compression_loop  # noqa: E402
from watcher_logger import info, warn, error, exception  # noqa: E402
from memory_bridge import tool_smart_search, tool_add_drawer, _CHUNK_THRESHOLD  # noqa: E402
from capture import load_recent_outcomes  # noqa: E402

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
    """Load recent outcomes STRUCTURALLY from the outcome ledger (#18).

    Uses ``capture.load_recent_outcomes`` — an exhaustive drawer listing + header/JSON
    parse + the structured ``timestamp`` field — instead of the old fuzzy semantic
    search + regex-prose parsing. Exhaustive (not a top-N vector search) so the loop
    sees every recent outcome; reliably parsed so clustering/targeting/drafting run on
    clean inputs. Never raises.
    """
    info(
        "compression_runner",
        "Loading recent outcomes (structured, from the ledger)",
        session_id=session_id,
        data={"window_days": window_days, "limit": limit},
    )
    try:
        outcomes = load_recent_outcomes(window_days)
    except Exception as exc:
        exception("compression_runner", "Failed to load outcomes", exc, session_id=session_id)
        return []

    if limit and len(outcomes) > limit:
        outcomes = outcomes[:limit]
    if not outcomes:
        warn(
            "compression_runner",
            "No recent outcome records in the ledger",
            session_id=session_id,
        )
        return []

    info(
        "compression_runner",
        f"Loaded {len(outcomes)} recent outcome records",
        session_id=session_id,
        data={"parsed": len(outcomes)},
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

    # A drawer over the bridge's chunking threshold gets silently split into
    # fragments no amendment reader can parse — the record would be stored
    # but invisible to list/approve/apply/dedup forever. Refuse instead.
    if len(content) > _CHUNK_THRESHOLD:
        error(
            "compression_runner",
            f"Amendment {amendment_id} renders to {len(content)} chars, over the "
            f"{_CHUNK_THRESHOLD}-char chunking threshold; refusing to store an "
            "unparseable record",
            session_id=session_id,
        )
        return False

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
