"""Best-effort capture of a terminal run's outcome into ``penny/outcomes``.

This is the **capture** side of Penny's self-improvement loop. The nightly
compression job (``run_compression.py``), the twice-daily ambient watchers
(``signal_generators.py``), and the weekly digest (``run_digest.py``) all mine
``penny/outcomes`` — but that room went stale the moment the composable-skills
``learn`` skill (its former writer) was deleted in the engine pivot. With no
writer, every miner has been reading an empty room, so the loop produced
nothing. The engine is the single execution substrate now, so the engine's
terminal states are the correct, permanent home for this write.

Design constraints:
  * **Never affect the run.** Every failure is swallowed; capture is advisory.
  * **Format must satisfy all three readers.** The drawer is a compact
    ``key: value`` header line (so the mismatch watcher's 200-char *summary*
    always contains an unquoted ``delta_score: MISMATCH`` its regex can match)
    followed by a full JSON body (so the compression/digest JSON parsers get a
    structured record). See the parsers in ``run_compression._parse_outcome_record``
    and ``signal_generators._parse_outcome_text``.
  * **No test pollution.** The write is skipped under pytest and can be disabled
    with ``PENNY_CAPTURE_OUTCOMES=0``.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from .loans import loan_enabled

if TYPE_CHECKING:  # pragma: no cover
    from .context import RunContext

# Map a playbook NAME onto the outcome-ledger domain enum
# (schema.py DomainCategory). Unmapped playbooks fall back to "other".
_DOMAIN_BY_PLAYBOOK = {
    "code": "coding",
    "coding": "coding",
    "jsa": "coding",
    "sca": "coding",
    "research": "research",
    "plan": "planning",
    "prd": "planning",
    "rez": "communication",
    "agent": "other",
}


def _capture_enabled() -> bool:
    """Capture is on in production, off under tests / when disabled."""
    if os.environ.get("PENNY_CAPTURE_OUTCOMES", "1") == "0":
        return False
    if "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules:
        return False
    return True


def _resolve_project_root(ctx: "RunContext") -> Optional[Path]:
    candidate = getattr(ctx, "project_root", "") or os.environ.get("PROJECT_ROOT", "")
    if candidate and (Path(candidate) / "scripts" / "system" / "bridge").is_dir():
        return Path(candidate)
    # Fall back to walking up from this file: .../penny/apps/orchestration/src/orchestration/
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "scripts" / "system" / "bridge" / "memory_bridge.py").is_file():
            return parent
    return None


def _delta_score(ctx: "RunContext") -> str:
    """MATCH (goal met) / MISMATCH (goal not met).

    A run that iterated before meeting its goal is still a success — labeling
    it PARTIAL counted it as suboptimal everywhere (mismatch watcher, eval
    suite) and made the staleness watcher flag it "unresolved" forever:
    decision_ids are unique run_ids, so the watcher's "resolved by a newer
    MATCH for the same decision_id" condition can never fire. The iteration
    count is captured separately in the JSON body.
    """
    return "MATCH" if getattr(ctx, "met", False) else "MISMATCH"


def _one_line(text: Any, limit: int = 240) -> str:
    """Collapse a value to a single, header-safe line."""
    s = str(text or "").replace("\n", " ").replace("\r", " ").strip()
    return s[:limit]


def _reason(ctx: "RunContext", delta: str) -> str:
    """A normalized, GROUPABLE failure reason.

    compression_loop.identify_patterns groups outcomes by this exact field and
    only proposes an amendment when the same reason recurs (>=2). So it must be
    a coarse category (the first error/gap, lowercased + truncated), NOT unique
    per-run text — otherwise every run is its own singleton and no pattern ever
    forms. Without this field the compression job yields zero patterns forever.
    """
    if delta == "MATCH":
        iteration = getattr(ctx, "iteration", 0)
        return (
            "goal met on first pass" if iteration <= 1 else f"goal met after {iteration} iterations"
        )
    errors = list(getattr(ctx, "errors", []) or [])
    gaps = list(getattr(ctx, "verify_gaps", []) or [])
    raw = errors[0] if errors else (gaps[0] if gaps else "")
    norm = _one_line(raw, 80).lower().strip()
    if norm:
        return norm
    return "goal not met" if delta == "MISMATCH" else "partial completion"


# Verifier-gap text → a categorical failure_mode. These values MIRROR
# capture.FAILURE_MODES (the vocabulary the compression loop clusters on); a test
# asserts the subset relationship so the two can't drift. Only VERIFY GAPS —
# genuine work-quality descriptions from vera — are classified this way. A hard
# orchestration error (bad contract, retries exhausted, step cap) is a PROCESS
# failure, not a work-quality category, so it stays "other" and
# compression_loop._grouping_key falls back to its already-repeatable error
# string for clustering.
_FAILURE_MODE_KEYWORDS = (
    (
        "missing_constraint",
        (
            "missing",
            "constraint",
            "requirement",
            "did not address",
            "not addressed",
            "omitted",
            "ignored",
            "left out",
        ),
    ),
    (
        "unverified_claim",
        (
            "unverified",
            "no evidence",
            "unsupported",
            "not grounded",
            "no citation",
            "unsubstantiated",
            "fabricat",
        ),
    ),
    (
        "wrong_result",
        (
            "wrong",
            "incorrect",
            "does not work",
            "doesn't work",
            "broken",
            "fails",
            "failing",
            "bug",
        ),
    ),
    ("incomplete", ("incomplete", "partial", "unfinished", "not implemented", "stub", "todo")),
)


def _failure_mode(ctx: "RunContext", delta: str) -> str:
    """Categorical failure key for the compression loop (mirrors
    capture.FAILURE_MODES). Empty for a MATCH.

    The keyword classifier is a tagged LOAN (``failure_mode_keywords`` in
    ``loans.py``): a hand-built substitute for model judgment over the gap
    text. Ablated, gap-ful mismatches fall back to the uncategorized bucket the
    compression loop already clusters by its repeatable reason string."""
    if delta != "MISMATCH":
        return ""
    gaps = list(getattr(ctx, "verify_gaps", []) or [])
    if gaps:
        if not loan_enabled("failure_mode_keywords"):
            return "incomplete"  # scaffold-OFF: no keyword knowledge applied
        text = " ".join(str(g) for g in gaps).lower()
        for mode, keywords in _FAILURE_MODE_KEYWORDS:
            if any(k in text for k in keywords):
                return mode
        return "incomplete"  # verifier found gaps but nothing more specific matched
    # No verify gaps → a hard orchestration error; leave categorical clustering
    # to the (repeatable) error string via compression_loop._grouping_key.
    return "other"


def build_outcome_content(ctx: "RunContext", now: Optional[datetime] = None) -> str:
    """Render the drawer content (header line + JSON body). Pure; unit-tested."""
    now = now or datetime.now(timezone.utc)
    ts = now.isoformat()
    playbook = getattr(ctx, "playbook", "") or "unknown"
    domain = _DOMAIN_BY_PLAYBOOK.get(playbook, "other")
    delta = _delta_score(ctx)
    run_id = getattr(ctx, "run_id", "") or "unknown"
    session_id = getattr(ctx, "session_id", "") or "unknown"
    confidence = getattr(ctx, "last_confidence", "") or ""
    errors = list(getattr(ctx, "errors", []) or [])
    verify_gaps = list(getattr(ctx, "verify_gaps", []) or [])

    # Header line: keep the mismatch-signal fields FIRST so they survive the
    # 200-char summary truncation the mismatch watcher reads.
    header = (
        f"decision_id: {run_id} | delta_score: {delta} | domain: {domain} | "
        f"session_id: {session_id} | confidence_at_action: {confidence} | timestamp: {ts}"
    )

    body = {
        "decision_id": run_id,
        "run_id": run_id,
        "session_id": session_id,
        "playbook": playbook,
        "domain": domain,
        "action_taken": _one_line(getattr(ctx, "goal", "")),
        "expected_outcome": _one_line(
            "; ".join(str(c) for c in getattr(ctx, "success_criteria", []) or [])
            or "goal satisfied"
        ),
        "actual_outcome": _one_line(
            "met"
            if getattr(ctx, "met", False)
            else "; ".join(str(e) for e in errors[:3]) or "not met"
        ),
        "delta_score": delta,
        "outcome": delta,  # dup for readers that key on `outcome` directly
        # `reason` is the human-readable detail; `failure_mode` is the
        # CATEGORICAL key compression_loop._grouping_key clusters on (empty for a
        # MATCH). Derived from the verifier gaps for engine terminals.
        "reason": _reason(ctx, delta),
        "failure_mode": _failure_mode(ctx, delta),
        "confidence_at_action": confidence,
        "iteration": getattr(ctx, "iteration", 0),
        "verify_verdict": getattr(ctx, "verify_verdict", ""),
        "verify_gaps": [_one_line(g, 160) for g in verify_gaps[:5]],
        # Ledger records outcome+evidence (atomic-loop checklist): the capped
        # digest of the most recent SUMMARY evidence the engine captured.
        "verify_evidence": [
            _one_line(e, 200) for e in list(getattr(ctx, "verify_evidence", []) or [])[:3]
        ],
        "errors": [_one_line(e, 200) for e in errors[:5]],
        "timestamp": ts,
    }
    return header + "\n" + json.dumps(body)


def record_outcome(ctx: "RunContext") -> bool:
    """Write one outcome drawer for a terminal run. Best-effort; never raises."""
    try:
        if not _capture_enabled():
            return False
        root = _resolve_project_root(ctx)
        if root is None:
            return False
        bridge_dir = str(root / "scripts" / "system" / "bridge")
        if bridge_dir not in sys.path:
            sys.path.insert(0, bridge_dir)
        from memory_bridge import tool_add_drawer  # type: ignore

        content = build_outcome_content(ctx)
        result = tool_add_drawer(
            {
                "wing": "penny",
                "room": "outcomes",
                "content": content,
                "added_by": f"engine:{getattr(ctx, 'playbook', 'unknown')}",
                "source_file": "apps/orchestration/src/orchestration/engine.py",
                "type": "outcome",
            }
        )
        return bool(isinstance(result, dict) and result.get("success"))
    except Exception:
        # Capture must never break a run.
        return False
