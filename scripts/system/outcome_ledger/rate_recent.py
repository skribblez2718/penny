#!/usr/bin/env python3
"""Human quick-rating — turn recent real work into high-signal outcomes.

The outcome ledger's only wired source is the orchestration engine's terminal
state, which production rarely reaches (Penny works mostly via direct agent
calls). This CLI gives the ledger a source that matches reality AND the moderate
human-feedback budget: it lists recent sessions (each session's opening request
is the goal) that don't yet have an outcome, and lets you rate each in one
keystroke — MATCH / PARTIAL / MISMATCH / skip — with an optional one-line reason.

    make rate                 # interactive rating of recent unrated sessions
    make rate ARGS=--json     # non-interactive: how many await rating (for the brief)

Each rating writes an outcome via ``capture.record_work_outcome`` (with the
reason the compression loop clusters on), so the nightly compression cron finally
has something to mine. The reason on a MISMATCH is the highest-value field —
it's what turns "this went wrong" into "this KIND of thing keeps going wrong."
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "judgment"))

from capture import (  # noqa: E402
    FAILURE_MODES,
    _bridge_deleter,
    default_decision_id,
    existing_decision_ids,
    infer_domain,
    load_outcomes_by_source,
    override_outcome,
    record_work_outcome,
)

OBS_DB = os.environ.get("PENNY_OBS_DB") or os.path.expanduser(
    "~/.local/share/penny/observability/observability.db"
)

_KEY_TO_DELTA = {"m": "MATCH", "p": "PARTIAL", "x": "MISMATCH"}

# Accept both the one-key form (m/p/x) and the full word, case-insensitively —
# so the args-based path Penny drives (`--verdict mismatch`) and the terminal
# keystroke path share one normalizer.
_VERDICT_ALIASES = {
    "m": "MATCH", "match": "MATCH",
    "p": "PARTIAL", "partial": "PARTIAL",
    "x": "MISMATCH", "mismatch": "MISMATCH",
}


def _normalize_verdict(value: str) -> Optional[str]:
    return _VERDICT_ALIASES.get((value or "").strip().lower())


def open_obs(path: str = OBS_DB) -> Optional[sqlite3.Connection]:
    if not os.path.exists(path):
        return None
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _extract_text(data: str) -> str:
    """Pull the user's prompt text out of an entry's JSON ``data`` blob."""
    try:
        obj = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return ""
    content = obj.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("text"))
    return ""


def recent_session_goals(con: sqlite3.Connection, limit: int = 25) -> List[Tuple[str, str, int]]:
    """(session_id, goal, ts) for the most recent sessions, goal = first user prompt.

    Uses each session's earliest role='user' entry as the goal.
    """
    rows = con.execute(
        """
        SELECT session_id, data, MIN(timestamp) AS ts
        FROM entries
        WHERE role = 'user'
        GROUP BY session_id
        ORDER BY ts DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    goals: List[Tuple[str, str, int]] = []
    for session_id, data, ts in rows:
        goal = _extract_text(data).strip()
        if goal:
            goals.append((session_id, goal, ts or 0))
    return goals


def pending_sessions(
    goals: List[Tuple[str, str, int]], existing_ids: set, min_goal_len: int = 25
) -> List[Tuple[str, str, int]]:
    """Sessions with a substantive goal and no outcome yet."""
    pending = []
    for session_id, goal, ts in goals:
        if len(goal) < min_goal_len:
            continue  # skip greetings / trivial one-liners
        if default_decision_id(session_id, goal) in existing_ids:
            continue
        pending.append((session_id, goal, ts))
    return pending


def goal_for_session(con: sqlite3.Connection, session_id: str) -> str:
    """The canonical goal (first user prompt) for one session — so a recorded
    rating's decision_id is stable regardless of what text a caller passes back,
    keeping dedup consistent with the judge's auto-capture of the same session."""
    row = con.execute(
        "SELECT data FROM entries WHERE session_id = ? AND role = 'user' "
        "ORDER BY timestamp, id LIMIT 1",
        (session_id,),
    ).fetchone()
    return _extract_text(row[0]).strip() if row else ""


def list_unrated(con: sqlite3.Connection, existing_ids: set, limit: int = 25) -> List[dict]:
    """Unrated recent sessions with the goal AND the response, for a caller
    (Penny, in-conversation) to present for the human's judgment. This is the
    read half of the args-based rating interface that replaces the terminal
    ``input()`` loop — the interactivity moves to the chat, not stdin."""
    # Lazy import avoids an import cycle (auto_capture imports from this module).
    from auto_capture import recent_unrated_tasks  # noqa: E402

    return [
        {"session_id": sid, "goal": goal, "response": response, "domain": infer_domain(goal)}
        for sid, goal, response in recent_unrated_tasks(con, existing_ids, limit)
    ]


def record_rating(
    con: sqlite3.Connection,
    session_id: str,
    verdict: str,
    reason: str = "",
    failure_mode: str = "",
    existing_ids: Optional[set] = None,
    writer=None,
) -> Optional[str]:
    """Record one rating from arguments (no stdin). Returns the decision_id, or
    None on a bad verdict or a duplicate. The goal is looked up canonically so
    the id is stable. This is the write half of the args-based interface."""
    delta = _normalize_verdict(verdict)
    if delta is None:
        return None
    goal = goal_for_session(con, session_id)
    return record_work_outcome(
        goal=goal,
        action_taken=goal,
        delta_score=delta,
        confidence="",
        reason=reason,
        failure_mode=failure_mode,
        session_id=session_id,
        user_feedback="human-rated",
        source="human_rating",
        existing_ids=existing_ids,
        writer=writer,
    )


def _rate_one(session_id: str, goal: str, existing_ids: set) -> Optional[str]:
    """Prompt for one rating; return the written decision_id or None if skipped."""
    print("\n" + "─" * 70)
    print(f"session {session_id[:18]}  ·  domain: {infer_domain(goal)}")
    print(f"  {goal[:300]}")
    choice = input("  [m]atch / [p]artial / mis[x]atch / [s]kip / [q]uit > ").strip().lower()
    if choice in ("q", "quit"):
        raise KeyboardInterrupt
    delta = _KEY_TO_DELTA.get(choice[:1])
    if delta is None:
        return None  # skip
    reason = ""
    failure_mode = ""
    if delta in ("PARTIAL", "MISMATCH"):
        reason = input("  one-line reason (what kind of thing went wrong) > ").strip()
        failure_mode = _prompt_failure_mode()
    return record_work_outcome(
        goal=goal,
        action_taken=goal,
        delta_score=delta,
        confidence="",
        reason=reason,
        failure_mode=failure_mode,
        session_id=session_id,
        user_feedback="human-rated",
        source="human_rating",
        existing_ids=existing_ids,
    )


def _prompt_failure_mode() -> str:
    """One-keystroke pick of the categorical failure mode (the clustering key).
    Enter/invalid → 'other'. This is the field that makes pattern mining fire."""
    print("  failure mode (the KIND of failure — makes patterns cluster):")
    for i, fm in enumerate(FAILURE_MODES, 1):
        print(f"    {i}) {fm}")
    raw = input(f"  pick 1-{len(FAILURE_MODES)} [Enter = other] > ").strip()
    if raw.isdigit() and 1 <= int(raw) <= len(FAILURE_MODES):
        return FAILURE_MODES[int(raw) - 1]
    return "other"


def _safe_existing_ids(quiet: bool) -> set:
    try:
        return existing_decision_ids()
    except Exception as exc:  # noqa: BLE001 — degrade gracefully
        if not quiet:
            print(f"(could not read existing outcomes: {exc}; treating all as unrated)")
        return set()


def _run_interactive(pending: List[Tuple[str, str, int]], existing: set) -> None:
    print(f"{len(pending)} recent session(s) await your rating (Ctrl-C / q to stop).")
    written = 0
    try:
        for session_id, goal, _ in pending:
            if _rate_one(session_id, goal, existing):
                written += 1
    except (KeyboardInterrupt, EOFError):
        print()
    print(f"\nRecorded {written} outcome(s) to penny/outcomes. Nightly compression will mine them.")


def _review_one(record: dict) -> bool:
    """Show one judge_auto verdict; let the human keep or override. Returns True
    if an override was written."""
    goal = str(record.get("expected_outcome") or record.get("action_taken") or "")
    verdict = str(record.get("delta_score") or "")
    reason = str(record.get("reason") or "")
    print("\n" + "─" * 70)
    print(f"judge said: {verdict}" + (f"  ·  {reason}" if reason else ""))
    print(f"  goal: {goal[:200]}")
    choice = input("  [k]eep / [o]verride / [s]kip / [q]uit > ").strip().lower()
    if choice in ("q", "quit"):
        raise KeyboardInterrupt
    if choice[:1] != "o":
        return False  # keep / skip
    new = input("  corrected verdict [m]atch / [p]artial / mis[x]atch > ").strip().lower()
    new_delta = _KEY_TO_DELTA.get(new[:1])
    if new_delta is None:
        print("  (no valid verdict — left unchanged)")
        return False
    note = input("  one-line reason > ").strip()
    ok = override_outcome(
        record, new_delta, user_feedback="human-override", reason=note, deleter=_bridge_deleter
    )
    if ok:
        _feed_corpus(record, new_delta, note)
    return ok


def _feed_corpus(record: dict, new_delta: str, note: str) -> None:
    """A human override is a case the judge got wrong → add it to the calibration
    corpus so the verifier recalibrates. Best-effort."""
    try:
        from run_judge_agreement import append_corpus_record  # type: ignore

        artifact = str(record.get("action_taken") or record.get("expected_outcome") or "")
        append_corpus_record(
            artifact=artifact,
            verdict="PASS" if new_delta == "MATCH" else "FAIL",
            reasoning=note,
            record_id=f"override_{record.get('decision_id', '')}",
        )
    except Exception as exc:  # noqa: BLE001 — corpus feed is best-effort
        print(f"  (could not update calibration corpus: {exc})")


def run_review() -> int:
    autos = load_outcomes_by_source("judge_auto")
    if not autos:
        print("No auto-captured outcomes to review. ✓")
        return 0
    print(f"Reviewing {len(autos)} judge-captured outcome(s) (q to stop).")
    overridden = 0
    try:
        for record in autos:
            if _review_one(record):
                overridden += 1
    except (KeyboardInterrupt, EOFError):
        print()
    print(f"\nOverrode {overridden} verdict(s); each correction recalibrates the judge.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print pending count as JSON and exit")
    parser.add_argument("--limit", type=int, default=25, help="recent sessions to consider")
    parser.add_argument(
        "--review",
        action="store_true",
        help="review auto-captured (judge) verdicts; override feeds the calibration corpus",
    )
    # Args-based interface Penny drives in-conversation (no stdin / TTY):
    parser.add_argument(
        "--list", action="store_true", help="print unrated sessions (goal+response) as JSON"
    )
    parser.add_argument(
        "--record", action="store_true", help="record one rating from --session/--verdict/..."
    )
    parser.add_argument("--session", default="", help="session_id to record (with --record)")
    parser.add_argument("--verdict", default="", help="match|partial|mismatch (with --record)")
    parser.add_argument("--reason", default="", help="one-line reason (with --record)")
    parser.add_argument("--failure-mode", dest="failure_mode", default="", help="failure category")
    args = parser.parse_args()

    if args.review:
        return run_review()

    con = open_obs()

    if args.list:
        items = list_unrated(con, _safe_existing_ids(True), args.limit) if con is not None else []
        print(json.dumps({"unrated": items}))
        return 0

    if args.record:
        if con is None:
            print(json.dumps({"error": "no observability db"}))
            return 1
        did = record_rating(con, args.session, args.verdict, args.reason, args.failure_mode)
        print(json.dumps({"decision_id": did} if did else {"error": "bad verdict or duplicate"}))
        return 0 if did else 1

    if con is None:
        msg = {"pending": 0, "error": "no observability db"}
        print(
            json.dumps(msg) if args.json else "No observability database found — nothing to rate."
        )
        return 0

    pending = pending_sessions(recent_session_goals(con, args.limit), _safe_existing_ids(args.json))

    if args.json:
        print(json.dumps({"pending": len(pending)}))
    elif not pending:
        print("Nothing to rate — recent sessions already have outcomes. ✓")
    else:
        _run_interactive(pending, _safe_existing_ids(args.json))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
