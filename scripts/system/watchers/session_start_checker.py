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
from datetime import timezone
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
    _parse_dt,
)
from watcher_logger import info, exception, debug  # noqa: E402
from memory_bridge import tool_smart_search, tool_diary_read  # noqa: E402

# Where the injected session-memory brief is written. The environment
# extension reads this at before_agent_start and splices it into the system
# prompt, so recalled memory finally reaches the model's context (the old
# ctx.ui.notify path rendered to the TUI status line and never did).
SESSION_BRIEF_PATH = _PROJECT_ROOT / ".penny" / "SESSION_BRIEF.md"
_BRIEF_DIARY_CHARS = 240


def get_pending_signals(limit: int = 10, session_id: str = "") -> dict[str, list[dict]]:
    """
    Retrieve pending signals for presentation at session start.

    Returns dict with:
    - critical: list of CRITICAL signals (sorted by timestamp desc)
    - info: list of INFO signals (sorted by timestamp desc)
    """
    debug(
        "session_start_checker",
        "Fetching pending signals",
        session_id=session_id,
        data={"limit": limit},
    )
    search = tool_smart_search(
        {
            "query": "pending signals PENDING",
            "wing": "penny",
            "room": "signals",
            "limit": limit * 2,
            "include_full": True,
        }
    )
    results = search.get("results", [])

    critical: list[dict] = []
    info_signals: list[dict] = []
    now = _now()

    for r in results:
        text = r.get("text", "")
        sig = _parse_signal_text(text)
        if not sig or sig.get("status") != "PENDING":
            continue
        # Skip expired PENDING signals — otherwise a signal whose 7-day TTL
        # lapsed keeps re-surfacing every session forever (its lifecycle had no
        # exit). The archiver deletes them; this stops showing them meanwhile.
        expires = sig.get("expires", "")
        exp_dt = _parse_dt(expires) if expires else None
        if exp_dt is not None:
            if exp_dt.tzinfo is None:  # normalize legacy naive stamps to UTC
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if exp_dt < now:
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
    """Retrieve amendments that still need a human step, for the session brief.

    Returns PENDING (awaiting review) AND APPROVED (awaiting apply) amendments,
    sorted by proposed_date desc. APPROVED stays surfaced so an approve-now,
    apply-later flow doesn't silently lose the proposal; resolved amendments
    (APPLIED/REJECTED) are excluded and age out via the tiered archiver.
    """
    debug(
        "session_start_checker",
        "Fetching amendments needing action",
        session_id=session_id,
        data={"limit": limit},
    )
    search = tool_smart_search(
        {
            "query": "amendment pending approved awaiting review apply",
            "wing": "penny",
            "room": "system_amendments",
            "limit": limit * 3,
            "include_full": True,
        }
    )
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
            if amend.get("status") in ("PENDING", "APPROVED"):
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
    """Retrieve the most recent weekly digest.

    Selects by the digest's own ``week_start`` field rather than requiring an
    exact ``digest_<this-monday>`` id match — the generator keys digests to the
    *prior* week, so an exact current-week query never matched.
    """
    debug("session_start_checker", "Fetching most recent weekly digest", session_id=session_id)
    search = tool_smart_search(
        {
            "query": "weekly digest summary decisions attention",
            "wing": "penny",
            "room": "digests",
            "limit": 6,
            "include_full": True,
        }
    )
    results = search.get("results", [])
    digests: list[dict[str, Any]] = []
    for r in results:
        text = r.get("text", "")
        lines = text.splitlines()
        json_blob = "\n".join(lines[1:]) if lines and lines[0].startswith("digest_id:") else text
        try:
            d = json.loads(json_blob)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(d, dict) and d.get("week_start"):
            digests.append(d)

    if not digests:
        debug("session_start_checker", "No weekly digest found", session_id=session_id)
        return None

    digest = max(digests, key=lambda d: d.get("week_start", ""))
    info(
        "session_start_checker",
        "Weekly digest retrieved",
        session_id=session_id,
        data={
            "week": digest.get("week_start"),
            "has_attention": bool(digest.get("attention_flags")),
        },
    )
    return digest


def format_signal_presentation(  # noqa: C901 (pre-existing; section-by-section formatter)
    pending: dict[str, list[dict]],
    amendments: list[dict] | None = None,
    digest: dict[str, Any] | None = None,
) -> str:
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
        lines.append("\n## 📝 Amendments Awaiting Action")
        lines.append("Self-improvement proposals that need a step from you (review, or apply):")
        for a in amendments:
            # PENDING → still to review; APPROVED → reviewed, awaiting apply.
            action = "apply" if a.get("status") == "APPROVED" else "review"
            lines.append(
                f"\n- **{a['amendment_id']}** [{action}] → "
                f"`{a['target_file'].split('/')[-1]}` (Risk: {a.get('risk', '?')})"
            )
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
            lines.append(
                f"\n📊 Weekly Digest available — {digest.get('summary', {}).get('decisions', 0)} decisions this week"
            )

    if not critical and not info and not amendments and not digest:
        lines.append("## No pending signals, amendments, or digest")

    return "\n".join(lines)


def get_recent_diary(limit: int = 3, session_id: str = "") -> list[dict]:
    """Return the most recent diary entries for the main agent."""
    try:
        res = tool_diary_read({"agent_name": "penny", "last_n": limit})
    except Exception as exc:
        exception(
            "session_start_checker", "diary_read failed for brief", exc, session_id=session_id
        )
        return []
    return res.get("entries", []) if isinstance(res, dict) else []


def get_recent_mismatches(limit: int = 3, session_id: str = "") -> list[dict]:
    """Return recent MISMATCH outcome records (for a 'don't repeat this' cue)."""
    try:
        search = tool_smart_search(
            {
                "query": "MISMATCH outcome decision",
                "wing": "penny",
                "room": "outcomes",
                "limit": limit * 3,
                "include_full": True,
            }
        )
    except Exception as exc:
        exception(
            "session_start_checker", "outcome fetch failed for brief", exc, session_id=session_id
        )
        return []

    out: list[dict] = []
    for r in search.get("results", []):
        text = r.get("text", "")
        lines = text.splitlines()
        blob = "\n".join(lines[1:]) if lines and not lines[0].lstrip().startswith("{") else text
        try:
            rec = json.loads(blob)
        except (json.JSONDecodeError, ValueError):
            continue
        verdict = rec.get("outcome") or rec.get("delta_score")
        if verdict == "MISMATCH":
            out.append(rec)
        if len(out) >= limit:
            break
    return out


def count_pending_ratings(session_id: str = "") -> int:
    """How many recent sessions have no outcome yet (for the rating nudge).

    Best-effort: any failure returns 0 so the brief still renders.
    """
    try:
        ledger_dir = str(_PROJECT_ROOT / "scripts" / "system" / "outcome_ledger")
        if ledger_dir not in sys.path:
            sys.path.insert(0, ledger_dir)
        import rate_recent  # type: ignore[import-not-found]
        from capture import existing_decision_ids  # type: ignore[import-not-found]

        con = rate_recent.open_obs()
        if con is None:
            return 0
        try:
            existing = existing_decision_ids()
        except Exception:  # noqa: BLE001
            existing = set()
        return len(
            rate_recent.pending_sessions(rate_recent.recent_session_goals(con, 25), existing)
        )
    except Exception as exc:  # noqa: BLE001 — never break the brief
        exception(
            "session_start_checker", "pending-ratings count failed", exc, session_id=session_id
        )
        return 0


def build_session_brief(
    pending: dict[str, list[dict]],
    amendments: list[dict],
    digest: dict[str, Any] | None,
    diary: list[dict],
    mismatches: list[dict],
    ratings_pending: int = 0,
) -> str:
    """Compose the trusted session-memory brief injected into the system prompt."""
    lines = [
        "<session_memory>",
        "## Session memory (recalled from prior sessions — trusted context)",
        "",
    ]
    body = format_signal_presentation(pending, amendments, digest).strip()
    if body and "No pending signals" not in body:
        lines.append(body)

    if ratings_pending > 0:
        lines.append(f"\n## 🗳️ {ratings_pending} recent session(s) await your outcome rating")
        lines.append(
            "- Run `make rate` to record MATCH/MISMATCH — this is the signal the "
            "self-improvement flywheel learns from."
        )

    if diary:
        lines.append("\n## 📓 Recent diary")
        for e in diary[:3]:
            content = str(e.get("content", "")).replace("\n", " ").strip()[:_BRIEF_DIARY_CHARS]
            lines.append(f"- ({e.get('date', '')}) {content}")

    if mismatches:
        lines.append("\n## ⚠️ Recent MISMATCH outcomes — avoid repeating")
        for m in mismatches[:3]:
            action = str(m.get("action_taken", "")).replace("\n", " ").strip()[:160]
            lines.append(f"- {m.get('domain', '?')}: {action}")

    lines.append("</session_memory>")
    return "\n".join(lines)


def write_session_brief(content: str, path: Path = SESSION_BRIEF_PATH) -> bool:
    """Persist the brief for the environment extension to inject. Best-effort."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return True
    except OSError:
        return False


def check_and_generate_signals(session_id: str) -> list[str]:
    """
    Run all metric-based watchers and write signals to mempalace.
    Returns list of generated signal_ids.
    """
    return run_all_metric_watchers(session_id)


def main() -> None:  # noqa: C901 (linear entry point with defensive try/excepts)
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
        exception(
            "session_start_checker",
            "Failed to retrieve pending signals",
            exc,
            session_id=session_id,
        )
        pending_signals = {"critical": [], "info": []}

    try:
        pending_amendments = get_pending_amendments(limit=5, session_id=session_id)
    except Exception as exc:
        exception(
            "session_start_checker",
            "Failed to retrieve pending amendments",
            exc,
            session_id=session_id,
        )
        pending_amendments = []

    try:
        weekly_digest = get_weekly_digest(session_id=session_id)
    except Exception as exc:
        exception(
            "session_start_checker", "Failed to retrieve weekly digest", exc, session_id=session_id
        )
        weekly_digest = None

    # Phase C: format for presentation
    presentation = format_signal_presentation(pending_signals, pending_amendments, weekly_digest)

    # Phase C2: write the session-memory brief for system-prompt injection.
    try:
        diary_entries = get_recent_diary(limit=3, session_id=session_id)
        mismatches = get_recent_mismatches(limit=3, session_id=session_id)
        ratings_pending = count_pending_ratings(session_id=session_id)
        brief = build_session_brief(
            pending_signals,
            pending_amendments,
            weekly_digest,
            diary_entries,
            mismatches,
            ratings_pending,
        )
        brief_written = write_session_brief(brief)
    except Exception as exc:
        exception(
            "session_start_checker", "Failed to build session brief", exc, session_id=session_id
        )
        brief_written = False

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
        "brief_written": brief_written,
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
