"""Digest storage — write to and retrieve from mempalace.

Uses dependency injection (writer/searcher callables) for testability.
"""

import sys
from pathlib import Path
import json
from typing import Dict, Any, Callable, Optional

# Ensure bridge is importable (scripts/system/digest/ → project root = parents[3])
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BRIDGE_DIR = _PROJECT_ROOT / "scripts" / "system" / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))


def store_digest(
    digest: Dict[str, Any],
    writer: Optional[Callable] = None,
) -> Dict[str, Any]:
    """Store a digest JSON in mempalace (penny/digests).

    Args:
        digest: Structured digest JSON
        writer: Optional callable(wing, room, content) -> dict.
                Defaults to memory_bridge.tool_add_drawer.
    """
    if not digest or not isinstance(digest, dict):
        return {"success": False, "error": "Invalid digest: must be a non-empty dict"}

    if writer is None:
        from memory_bridge import tool_add_drawer

        writer = tool_add_drawer

    digest_id = digest.get("digest_id", "unknown")
    content = f"digest_id: {digest_id}\n" + json.dumps(digest, indent=2)

    try:
        result = writer({"wing": "penny", "room": "digests", "content": content})
        return {
            "success": result.get("success", False),
            "drawer_id": result.get("drawer_id"),
            "error": result.get("error"),
        }
    except Exception as e:
        return {"success": False, "error": f"Storage failed: {e}"}


def get_digest_for_week(
    week_start: str,
    searcher: Optional[Callable] = None,
) -> Optional[Dict[str, Any]]:
    """Retrieve digest for a specific week start date.

    Args:
        week_start: ISO date string (e.g., "2026-04-21")
        searcher: Optional callable for searching mempalace.
                  Defaults to memory_bridge.tool_smart_search.
    """
    if searcher is None:
        from memory_bridge import tool_smart_search

        searcher = tool_smart_search

    try:
        result = searcher(
            {
                "query": f"digest_id: digest_{week_start}",
                "wing": "penny",
                "room": "digests",
                "limit": 3,
                "include_full": True,
            }
        )
        results = result.get("results", [])
        if not results:
            return None

        # Parse the first result
        text = results[0].get("text", "")
        lines = text.splitlines()
        if len(lines) > 1 and lines[0].startswith("digest_id:"):
            json_blob = "\n".join(lines[1:])
        else:
            json_blob = text

        return json.loads(json_blob)
    except (json.JSONDecodeError, Exception):
        return None
