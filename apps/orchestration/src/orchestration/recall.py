"""Recall (atom F2) — run-start retrieval of distilled lessons into the first
agent's context.

The learning loop's read side (docs/agents/skills/loops.md Rec 3; the "(gap:
run-start reflection retrieval)" row in atomic-loop-components.md): the Distill
side compresses ``penny/outcomes`` into lessons in ``penny/system_amendments``;
this module retrieves the few most relevant ones at ``start()`` so each run is
seeded with what prior runs learned. Code retrieves, the model applies.

Design constraints (mirrors ``outcome_writer``):
  * **Never affect the run.** Every failure returns ``[]``; recall is advisory.
  * **Advisory, never gating.** Lessons are injected as context lines the model
    weighs against current evidence; no engine routing ever reads them.
  * **No test pollution.** The default MemPalace-backed search is skipped under
    pytest; tests inject an explicit ``search_fn``.
  * Opt-out: ``PENNY_RECALL=0`` env, or ``constraints={"recall": False}``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover
    from .context import RunContext

# Bounds keeping the seeded context a digest, not a payload dump.
MAX_LESSONS = 3
MAX_LESSON_CHARS = 400

SearchFn = Callable[[str, int], list[str]]


def _recall_opted_out(ctx: "RunContext") -> bool:
    if os.environ.get("PENNY_RECALL", "1") == "0":
        return True
    constraints = getattr(ctx, "constraints", None) or {}
    return constraints.get("recall") is False


def _under_pytest() -> bool:
    return "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules


def _one_line(text: Any, limit: int = MAX_LESSON_CHARS) -> str:
    s = str(text or "").replace("\n", " ").replace("\r", " ").strip()
    return s if len(s) <= limit else s[:limit] + " …[truncated]"


def _resolve_project_root(ctx: "RunContext") -> Optional[Path]:
    candidate = getattr(ctx, "project_root", "") or os.environ.get("PROJECT_ROOT", "")
    if candidate and (Path(candidate) / "scripts" / "system" / "bridge").is_dir():
        return Path(candidate)
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "scripts" / "system" / "bridge" / "memory_bridge.py").is_file():
            return parent
    return None


def _bridge_search_fn(ctx: "RunContext") -> Optional[SearchFn]:
    """Default search seam: MemPalace smart search over penny/system_amendments.

    Same bridge-import pattern as ``outcome_writer.record_outcome`` (the
    established seam to MemPalace from engine-side Python)."""
    root = _resolve_project_root(ctx)
    if root is None:
        return None
    bridge_dir = str(root / "scripts" / "system" / "bridge")
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)
    try:
        from memory_bridge import tool_smart_search
    except Exception:
        return None

    def _search(query: str, limit: int) -> list[str]:
        result = tool_smart_search(
            {
                "query": query,
                "wing": "penny",
                "room": "system_amendments",
                "limit": limit,
                "include_full": False,
            }
        )
        if not isinstance(result, dict):
            return []
        return [
            str(r.get("summary") or r.get("text") or "")
            for r in result.get("results", [])
            if isinstance(r, dict)
        ]

    return _search


def recall_lessons(ctx: "RunContext", search_fn: SearchFn | None = None) -> list[str]:
    """Retrieve up to :data:`MAX_LESSONS` distilled lessons relevant to this run.

    Best-effort by contract: never raises, never blocks a run on failure. With
    no injected ``search_fn`` the MemPalace bridge is used (skipped under
    pytest so tests can never touch the real palace by accident).
    """
    try:
        if _recall_opted_out(ctx):
            return []
        if search_fn is None:
            if _under_pytest():
                return []
            search_fn = _bridge_search_fn(ctx)
            if search_fn is None:
                return []
        goal = _one_line(getattr(ctx, "goal", ""), 200)
        playbook = getattr(ctx, "playbook", "") or "run"
        query = f"lessons and amendments for {playbook} runs: {goal}"
        raw = search_fn(query, MAX_LESSONS)
        lessons = [_one_line(r) for r in raw if str(r or "").strip()]
        return lessons[:MAX_LESSONS]
    except Exception:
        return []
