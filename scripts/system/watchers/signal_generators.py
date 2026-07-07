"""
Ambient Watchers — Signal Generation Library

Generates structured signals based on detected conditions.
All functions write to penny/signals room via memory_add_drawer.
Deduplication via memory_check_duplicate before writing.

Run within the project's venv to access mempalace modules:
    source .venv/bin/activate
    python scripts/system/watchers/session_start_checker.py
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# Resolve project root relative to this script (scripts/system/watchers/ → project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BRIDGE_DIR = _PROJECT_ROOT / "scripts" / "system" / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

# Import bridge tool functions directly (they handle palace config + KG init).
from watcher_logger import info, warn, error, exception, debug  # noqa: E402
from memory_bridge import (  # noqa: E402
    tool_smart_search,
    tool_add_drawer,
    tool_check_duplicate,
    tool_list_drawers,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _default_expiry() -> str:
    return _iso(_now() + timedelta(days=7))


def _signal_id(source: str, seq: int) -> str:
    return f"signal_{_now().strftime('%Y-%m-%d')}_{seq:03d}_{source}"


def _parse_dt(text: str) -> Optional[datetime]:
    """Best-effort ISO-8601 datetime extraction from text."""
    # Look for YYYY-MM-DDTHH:MM:SS pattern
    m = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?)", text)
    if m:
        try:
            s = m.group(1)
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            return datetime.fromisoformat(s)
        except ValueError:
            pass
    return None


def _parse_confidence(text: str) -> Optional[str]:
    """Extract confidence level from outcome text."""
    m = re.search(r"confidence_at_action:\s*(\w+)", text)
    return m.group(1) if m else None


def _count_drawers(wing: str) -> int:
    """Return total drawer count for a wing."""
    result = tool_list_drawers({"wing": wing})
    if result.get("success"):
        return result.get("count", 0)
    return 0


def _outcome_from_json_line(text: str) -> Optional[dict]:
    """Return the first parseable JSON-object line of a drawer, or None."""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            return rec
    return None


def _outcome_from_header(text: str) -> dict:
    """Header ``key: value`` fallback for drawers without a JSON body."""
    rec: dict = {}
    m = re.search(r"decision_id:\s*([^|\n]+)", text)
    if m:
        rec["decision_id"] = m.group(1).strip()
    m = re.search(r"delta_score:\s*(\w+)", text)
    if m:
        rec["outcome"] = m.group(1)
    conf = _parse_confidence(text)
    if conf:
        rec["confidence_at_action"] = conf
    m = re.search(r"timestamp:\s*(\S+)", text)
    if m:
        rec["timestamp"] = m.group(1)
    return rec


def _parse_outcome_text(text: str) -> dict:
    """Parse one outcome drawer: JSON body line first, header regex fallback.

    Mirrors run_compression._parse_outcome_record semantics (delta_score is
    aliased to outcome) so every miner sees the same record.
    """
    rec = _outcome_from_json_line(text)
    if rec is None:
        return _outcome_from_header(text)
    if not rec.get("outcome") and rec.get("delta_score"):
        rec["outcome"] = rec["delta_score"]
    return rec


def _load_outcome_records() -> list:
    """Load EVERY outcome record with full content — the accurate ledger read.

    Replaces the old lossy measurement path (tool_smart_search limit 50 over
    200-char summaries + regex): similarity search sampled whatever the
    embedding ranked, and truncation could push the very fields being counted
    out of the summary — so watcher metrics were computed over a biased sample
    of the ledger, not the ledger. Each record carries ``_when`` (aware UTC
    from the record timestamp, falling back to the drawer's filed_at) or None.
    """
    result = tool_list_drawers(
        {"wing": "penny", "room": "outcomes", "limit": 10000, "include_content": True}
    )
    if not result.get("success"):
        return []
    records = []
    for drawer in result.get("drawers", []):
        rec = _parse_outcome_text(drawer.get("content") or "")
        if not rec:
            continue
        when = _parse_dt(str(rec.get("timestamp") or "")) or _parse_dt(
            str(drawer.get("filed_at") or "")
        )
        if when is not None and when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        rec["_when"] = when
        records.append(rec)
    return records


# ---------------------------------------------------------------------------
# Core signal writing / acknowledgment
# ---------------------------------------------------------------------------


def write_signal(signal: dict, session_id: str = "") -> Optional[str]:
    """
    Write a signal to penny/signals room.

    Pre-check: memory_check_duplicate to avoid duplicates (keyed by signal_id).
    Post-write: Return drawer_id on success, None on duplicate or error.
    """
    sid = signal.get("signal_id")
    if not sid:
        raise ValueError("signal must have signal_id")

    dup = tool_check_duplicate({"content": f"signal_id: {sid}", "threshold": 0.99})
    if dup.get("is_duplicate"):
        info("signal.write", f"Signal {sid} is a duplicate; skipping write", session_id=session_id)
        return None

    # Ensure signal_id is embedded in drawer text for dedup indexing
    full_text = f"signal_id: {sid}\n" + json.dumps(signal, indent=2)

    result = tool_add_drawer(
        {
            "wing": "penny",
            "room": "signals",
            "content": full_text,
        }
    )

    if result.get("success"):
        drawer_id = result.get("drawer_id")
        info(
            "signal.write",
            f"Signal {sid} written to penny/signals",
            session_id=session_id,
            data={
                "drawer_id": drawer_id,
                "signal_type": signal.get("signal_type"),
                "priority": signal.get("priority"),
            },
        )
        return drawer_id

    error(
        "signal.write",
        f"Failed to write signal {sid}",
        session_id=session_id,
        data={"result": result},
    )
    return None


def acknowledge_signal(signal_id: str, session_id: str) -> bool:
    """
    Mark a signal as acknowledged by user.

    Searches for the signal by signal_id, reads its current state,
    updates status and session_id, deletes the old drawer,
    and writes the updated signal back.

    Retries up to 3 times with 0.5s delays to account for ChromaDB
    eventual consistency after a fresh write.
    """
    for attempt in range(3):
        search = tool_smart_search(
            {
                "query": f"signal_id: {signal_id}",
                "wing": "penny",
                "room": "signals",
                "limit": 5,
                "include_full": True,
            }
        )
        results = search.get("results", [])

        signal = None
        drawer_id = None
        for r in results:
            text = r.get("text", "")
            lines = text.splitlines()
            try:
                parsed = json.loads("\n".join(lines[1:])) if len(lines) > 1 else json.loads(text)
                if parsed.get("signal_id") == signal_id:
                    signal = parsed
                    drawer_id = r.get("id")
                    break
            except json.JSONDecodeError:
                continue

        if signal is not None and drawer_id is not None:
            break

        if attempt < 2:
            import time

            time.sleep(0.5)

    if signal is None or drawer_id is None:
        return False

    signal["status"] = "ACKNOWLEDGED"
    signal["session_id"] = session_id

    from memory_bridge import tool_delete_drawer

    tool_delete_drawer({"drawer_id": drawer_id})

    new_id = write_signal(signal)
    return new_id is not None


# ---------------------------------------------------------------------------
# Metric-based watchers
# ---------------------------------------------------------------------------


def generate_mismatch_rate_signal(
    session_id: str,
    threshold: int = 3,
    window_days: int = 7,
) -> Optional[dict]:
    """
    Check outcome ledger for MISMATCH rate.

    Trigger: >N MISMATCH outcomes in last window_days.
    """
    debug(
        "mismatch_rate_watcher",
        "Starting mismatch rate check",
        session_id=session_id,
        data={"threshold": threshold, "window_days": window_days},
    )
    records = _load_outcome_records()
    if not records:
        debug("mismatch_rate_watcher", "No outcome records in ledger", session_id=session_id)
        return None

    cutoff = _now() - timedelta(days=window_days)
    recent = [
        r
        for r in records
        if r.get("outcome") in ("MATCH", "PARTIAL", "MISMATCH")
        and r.get("_when")
        and r["_when"] >= cutoff
    ]
    total_relevant = len(recent)
    mismatch_count = sum(1 for r in recent if r.get("outcome") == "MISMATCH")

    info(
        "mismatch_rate_watcher",
        f"Mismatch check complete: {mismatch_count} recent MISMATCH out of {total_relevant} relevant outcomes",
        session_id=session_id,
        data={
            "mismatch_count": mismatch_count,
            "total_relevant": total_relevant,
            "threshold": threshold,
        },
    )

    if mismatch_count > threshold:
        seq = 1
        priority = "CRITICAL" if mismatch_count > threshold * 2 else "INFO"
        return {
            "signal_id": _signal_id("mismatch_rate", seq),
            "signal_type": "METRIC",
            "source": "mismatch_rate_watcher",
            "priority": priority,
            "title": f"High MISMATCH rate: {mismatch_count} recent decisions",
            "context": f"{mismatch_count} decisions with MISMATCH delta in last {window_days} days (out of {total_relevant} checked)",
            "suggested_action": "Review recent MISMATCH outcomes in penny/outcomes room",
            "timestamp": _iso(_now()),
            "expires": _default_expiry(),
            "status": "PENDING",
        }

    return None


def generate_confidence_trend_signal(
    session_id: str,
    threshold: float = 0.5,
    window_days: int = 7,
) -> Optional[dict]:
    """
    Check outcome ledger for low confidence trend.

    Trigger: >threshold % of recent actions at POSSIBLE or UNCERTAIN confidence.
    """
    debug(
        "confidence_trend_watcher",
        "Starting confidence trend check",
        session_id=session_id,
        data={"threshold": threshold, "window_days": window_days},
    )
    cutoff = _now() - timedelta(days=window_days)
    recent = [r for r in _load_outcome_records() if r.get("_when") and r["_when"] >= cutoff]
    total = len(recent)
    low_confidence = sum(
        1
        for r in recent
        if str(r.get("confidence_at_action") or "").strip().upper() in ("POSSIBLE", "UNCERTAIN")
    )

    info(
        "confidence_trend_watcher",
        f"Confidence trend check complete: {low_confidence}/{total} low-confidence actions",
        session_id=session_id,
        data={"low_confidence": low_confidence, "total": total, "threshold": threshold},
    )

    if total > 0 and (low_confidence / total) > threshold:
        pct = int(low_confidence / total * 100)
        return {
            "signal_id": _signal_id("confidence_trend", 1),
            "signal_type": "METRIC",
            "source": "confidence_trend_watcher",
            "priority": "INFO",
            "title": f"Low confidence trend: {pct}% recent actions uncertain",
            "context": f"{low_confidence} of {total} recent actions at POSSIBLE or UNCERTAIN confidence in last {window_days} days",
            "suggested_action": "Consider adding more verification steps for uncertain tasks",
            "timestamp": _iso(_now()),
            "expires": _default_expiry(),
            "status": "PENDING",
        }

    return None


def generate_mempalace_growth_signal(
    session_id: str,
    drawer_count_threshold: int = 500,
) -> Optional[dict]:
    """
    Check for excessive mempalace growth.

    Trigger: Drawer count in penny wing exceeds threshold.
    """
    debug(
        "mempalace_growth_watcher",
        "Starting mempalace growth check",
        session_id=session_id,
        data={"drawer_count_threshold": drawer_count_threshold},
    )
    drawer_count = _count_drawers("penny")

    info(
        "mempalace_growth_watcher",
        f"Mempalace drawer count: {drawer_count}",
        session_id=session_id,
        data={"drawer_count": drawer_count, "threshold": drawer_count_threshold},
    )

    if drawer_count > drawer_count_threshold:
        return {
            "signal_id": _signal_id("mempalace_growth", 1),
            "signal_type": "METRIC",
            "source": "mempalace_growth_watcher",
            "priority": "INFO",
            "title": f"Mempalace growth: {drawer_count} drawers in penny wing",
            "context": f"Drawer count ({drawer_count}) exceeds threshold ({drawer_count_threshold})",
            "suggested_action": "Consider running mempalace cleanup or distillation pipeline",
            "timestamp": _iso(_now()),
            "expires": _default_expiry(),
            "status": "PENDING",
        }

    return None


def generate_task_staleness_signal(
    session_id: str,
    threshold_days: int = 7,
) -> Optional[dict]:
    """
    Check for unresolved PARTIAL/MISMATCH outcomes with no follow-up.

    Trigger: Outcome with delta in [PARTIAL, MISMATCH] and no newer entry
    for same decision_id within threshold_days.
    """
    debug(
        "task_staleness_watcher",
        "Starting task staleness check",
        session_id=session_id,
        data={"threshold_days": threshold_days},
    )
    records = [
        r for r in _load_outcome_records() if r.get("decision_id") and r.get("_when") is not None
    ]
    if not records:
        debug("task_staleness_watcher", "No dated outcome records in ledger", session_id=session_id)
        return None

    cutoff = _now() - timedelta(days=threshold_days)

    # Build a map: decision_id -> newest timestamp among MATCH outcomes
    newest_match: dict[str, datetime] = {}
    for r in records:
        if r.get("outcome") == "MATCH":
            did = str(r["decision_id"])
            newest_match[did] = max(newest_match.get(did, r["_when"]), r["_when"])

    # Count PARTIAL/MISMATCH outcomes in-window whose decision_id has no newer MATCH
    stale = 0
    for r in records:
        if r["_when"] < cutoff:
            continue  # beyond window
        if r.get("outcome") not in ("PARTIAL", "MISMATCH"):
            continue
        match_dt = newest_match.get(str(r["decision_id"]))
        if match_dt is None or match_dt <= r["_when"]:
            stale += 1

    info(
        "task_staleness_watcher",
        f"Task staleness check complete: {stale} stale decisions",
        session_id=session_id,
        data={"stale_count": stale, "threshold_days": threshold_days},
    )

    if stale > 0:
        priority = "CRITICAL" if stale >= 3 else "INFO"
        return {
            "signal_id": _signal_id("task_staleness", 1),
            "signal_type": "TIME",
            "source": "task_staleness_watcher",
            "priority": priority,
            "title": f"{stale} unresolved decisions need follow-up",
            "context": f"{stale} decisions with PARTIAL/MISMATCH delta and no recent MATCH follow-up in last {threshold_days} days",
            "suggested_action": "Review stale outcomes and determine resolution or update expected_outcome",
            "timestamp": _iso(_now()),
            "expires": _default_expiry(),
            "status": "PENDING",
        }

    return None


# ---------------------------------------------------------------------------
# Stub watchers (Phase 2 — FILE-based, post-MVP)
# ---------------------------------------------------------------------------


def generate_config_drift_signal(  # pylint: disable=unused-argument
    session_id: str, project_root: str = "."
) -> Optional[dict]:
    """STUB: Check for external modifications to critical config files."""
    return None


def generate_test_failure_signal(  # pylint: disable=unused-argument
    session_id: str, project_root: str = "."
) -> Optional[dict]:
    """STUB: Check for failing tests in project directories."""
    return None


def generate_project_dormancy_signal(  # pylint: disable=unused-argument
    session_id: str,
    project_root: str = ".",
    threshold_days: int = 14,
) -> Optional[dict]:
    """STUB: Check for project dormancy based on diary/sessions room."""
    return None


# ---------------------------------------------------------------------------
# Convenience: run all metric watchers
# ---------------------------------------------------------------------------


def run_all_metric_watchers(session_id: str) -> list[str]:
    """
    Run all MVP metric watchers and return list of generated signal_ids.
    """
    info("ambient_watchers", "Starting all metric watchers", session_id=session_id)
    generated: list[str] = []
    funcs = [
        generate_mismatch_rate_signal,
        generate_confidence_trend_signal,
        generate_mempalace_growth_signal,
        generate_task_staleness_signal,
    ]
    for fn in funcs:
        watcher_name = fn.__name__
        try:
            debug("ambient_watchers", f"Running watcher {watcher_name}", session_id=session_id)
            sig = fn(session_id)
            if sig:
                debug(
                    "ambient_watchers",
                    f"Watcher {watcher_name} generated signal {sig.get('signal_id')}",
                    session_id=session_id,
                )
                drawer_id = write_signal(sig, session_id=session_id)
                if drawer_id:
                    generated.append(sig["signal_id"])
                    info(
                        "ambient_watchers",
                        f"Signal {sig['signal_id']} persisted",
                        session_id=session_id,
                        data={
                            "watcher": watcher_name,
                            "drawer_id": drawer_id,
                            "priority": sig.get("priority"),
                        },
                    )
                else:
                    warn(
                        "ambient_watchers",
                        f"Signal {sig['signal_id']} from {watcher_name} was not persisted (duplicate or error)",
                        session_id=session_id,
                    )
            else:
                debug(
                    "ambient_watchers",
                    f"Watcher {watcher_name} produced no signal",
                    session_id=session_id,
                )
        except Exception as exc:
            exception(
                "ambient_watchers", f"Watcher {watcher_name} failed", exc, session_id=session_id
            )
            # Individual watcher failures must not crash the pipeline
            continue

    info(
        "ambient_watchers",
        f"All metric watchers completed: {len(generated)} signal(s) generated",
        session_id=session_id,
        data={"generated_signals": generated},
    )
    return generated


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else f"session_{_iso(_now())}"
    info("ambient_watchers", "Watcher process started", session_id=sid)
    try:
        ids = run_all_metric_watchers(sid)
        output = {"generated_signals": ids, "count": len(ids)}
        info(
            "ambient_watchers", "Watcher process finished successfully", session_id=sid, data=output
        )
        print(json.dumps(output, indent=2))
    except Exception as exc:
        exception("ambient_watchers", "Watcher process crashed", exc, session_id=sid)
        raise
