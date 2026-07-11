"""Flywheel liveness — is every stage of the learning loop actually receiving data?

Penny's past failures were all SILENT seam deaths: the auto-diary 401'd 3,079
times, the archiver no-opped for months, compression ran green nightly while
producing nothing. Green cron exit codes and passing unit tests never noticed.
These checks measure DELIVERY at each seam by reading the destination store,
not the sender's logs.
"""

from __future__ import annotations

import sys
from datetime import timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple

from eval_lib import (
    DOWN_GOOD,
    FAIL,
    PASS,
    REPO_ROOT,
    UP_GOOD,
    EvalResult,
    EvalSkip,
    days_since,
    list_drawers_all,
    load_outcomes,
    load_room,
    newest_filed_at,
    now_utc,
    obs_db_path,
    orch_db_path,
    parse_when,
    query_db,
    run_checks,
)

TERMINAL_WINDOW_DAYS = 14
SESSION_RECENT_DAYS = 2


def _terminal_runs(window_days: float = TERMINAL_WINDOW_DAYS) -> List[Dict[str, Any]]:
    rows = query_db(
        orch_db_path(),
        "SELECT run_id, status, updated_at FROM runs WHERE status IN ('complete', 'error')",
    )
    cutoff = now_utc() - timedelta(days=window_days)
    return [r for r in rows if (parse_when(r["updated_at"]) or cutoff) > cutoff]


def _latest_session_start() -> Optional[Any]:
    rows = query_db(
        obs_db_path(), "SELECT started_at FROM sessions ORDER BY started_at DESC LIMIT 1"
    )
    return parse_when(rows[0]["started_at"]) if rows else None


def check_outcome_capture() -> EvalResult:
    """Every terminal engine run must land one outcome drawer in penny/outcomes."""
    terminal = _terminal_runs()
    if not terminal:
        raise EvalSkip(f"no terminal engine runs in the last {TERMINAL_WINDOW_DAYS}d")
    outcome_ids = {str(o.get("decision_id") or o.get("run_id") or "") for o in load_outcomes()}
    missing = [r["run_id"] for r in terminal if r["run_id"] not in outcome_ids]
    ratio = 1.0 - len(missing) / len(terminal)
    if missing:
        return EvalResult(
            name="flywheel.outcome_capture",
            status=FAIL,
            value=ratio,
            direction=UP_GOOD,
            unit="fraction",
            detail=f"{len(missing)}/{len(terminal)} terminal runs wrote no outcome drawer: "
            + ", ".join(missing[:5]),
        )
    return EvalResult(
        name="flywheel.outcome_capture",
        status=PASS,
        value=1.0,
        direction=UP_GOOD,
        unit="fraction",
        detail=f"all {len(terminal)} terminal runs captured",
    )


def check_diary_delivery() -> EvalResult:
    """Sessions happening ⇒ diary entries landing (delivery, not attempt logs)."""
    latest_session = _latest_session_start()
    if latest_session is None or days_since(latest_session) > SESSION_RECENT_DAYS:
        raise EvalSkip(f"no sessions in the last {SESSION_RECENT_DAYS}d")
    newest = newest_filed_at(load_room("diary"))
    age = days_since(newest) if newest else None
    if age is None or age > SESSION_RECENT_DAYS + 1:
        return EvalResult(
            name="flywheel.diary_delivery",
            status=FAIL,
            value=age,
            direction=DOWN_GOOD,
            unit="days",
            detail=f"sessions active but newest diary drawer is "
            f"{'absent' if age is None else f'{age:.1f}d old'}",
        )
    return EvalResult(
        name="flywheel.diary_delivery",
        status=PASS,
        value=age,
        direction=DOWN_GOOD,
        unit="days",
        detail=f"newest diary drawer {age:.1f}d old",
    )


def check_autodiary_skips() -> EvalResult:
    """'Auto-diary skipped' warnings in the last 7d — should trend to ~0."""
    cutoff_ms = int((now_utc() - timedelta(days=7)).timestamp() * 1000)
    rows = query_db(
        obs_db_path(),
        "SELECT COUNT(*) AS n FROM logs WHERE component = 'memory' "
        "AND event = 'Auto-diary skipped' AND timestamp > ?",
        (cutoff_ms,),
    )
    count = float(rows[0]["n"]) if rows else 0.0
    return EvalResult(
        name="flywheel.autodiary_skips_7d",
        status=PASS,
        value=count,
        direction=DOWN_GOOD,
        unit="count",
        detail="capture-attempt failures logged by the memory extension (ratcheted)",
    )


def _archiver_module() -> Any:
    tiered = str(REPO_ROOT / "scripts" / "system" / "tiered_memory")
    if tiered not in sys.path:
        sys.path.insert(0, tiered)
    import archiver  # type: ignore[import-not-found]

    return archiver


def check_archiver_backlog() -> EvalResult:
    """Drawers past their TTL still in the hot store. A working archiver holds ~0."""
    archiver = _archiver_module()
    eligible = 0
    by_room: Dict[str, int] = {}
    for drawer in list_drawers_all():
        meta = archiver.DrawerMeta(
            drawer_id=drawer["id"],
            wing=drawer.get("wing", ""),
            room=drawer.get("room", ""),
            timestamp=drawer.get("filed_at", ""),
            recall_count=int(drawer.get("recall_count") or 0),
            last_recalled_at=drawer.get("last_recalled_at", ""),
        )
        should, _ = archiver.should_archive(meta)
        if should:
            eligible += 1
            key = f"{meta.wing}/{meta.room}"
            by_room[key] = by_room.get(key, 0) + 1
    top = ", ".join(f"{k}:{v}" for k, v in sorted(by_room.items(), key=lambda i: -i[1])[:4])
    return EvalResult(
        name="flywheel.archiver_backlog",
        status=PASS if eligible == 0 else FAIL,
        value=float(eligible),
        direction=DOWN_GOOD,
        unit="count",
        detail=f"TTL-expired drawers still hot ({top})" if eligible else "no expired drawers",
    )


def check_active_rooms_have_ttl() -> EvalResult:
    """Rooms receiving fresh writes must be classified by the tier config.

    The historic penny→wing_penny namespace split means live rooms (e.g.
    wing_penny/diary) can silently fall through TIER_CONFIG to keep-forever
    while their frozen penny/ twin decays.
    """
    archiver = _archiver_module()
    active_keys: set = set()
    for room in ("diary", "outcomes", "signals"):
        for drawer in load_room(room):
            age = days_since(drawer.get("filed_at"))
            if age is not None and age <= 30:
                active_keys.add((drawer.get("wing", ""), drawer.get("room", "")))
    unclassified: List[str] = []
    for wing, room in sorted(active_keys):
        meta = archiver.DrawerMeta(drawer_id="probe", wing=wing, room=room, timestamp="")
        _tier, ttl = archiver.classify_drawer(meta)
        key = f"{wing}/{room}"
        # keep-forever is only correct when the tier config SAYS so explicitly;
        # falling through to the default means the room was never classified.
        if ttl < 0 and key not in archiver.TIER_CONFIG:
            unclassified.append(key)
    if unclassified:
        return EvalResult(
            name="flywheel.active_rooms_have_ttl",
            status=FAIL,
            detail="actively-written rooms fall through TIER_CONFIG to keep-forever: "
            + ", ".join(sorted(unclassified)),
        )
    return EvalResult(
        name="flywheel.active_rooms_have_ttl",
        status=PASS,
        detail="all actively-written decay-class rooms are tier-classified",
    )


def check_compression_yield() -> EvalResult:
    """When recurring failure patterns exist, compression must produce amendments."""
    recent = load_outcomes(window_days=7)
    suboptimal = [o for o in recent if o.get("outcome") in ("MISMATCH", "PARTIAL")]
    reasons: Dict[str, int] = {}
    for record in suboptimal:
        reason = str(record.get("reason") or "").strip().lower()
        if reason:
            reasons[reason] = reasons.get(reason, 0) + 1
    patterns = [r for r, n in reasons.items() if n >= 2]
    if not patterns:
        return EvalResult(
            name="flywheel.compression_yield",
            status=PASS,
            detail=f"vacuously live: {len(recent)} outcomes / {len(suboptimal)} suboptimal "
            f"in 7d, {len(reasons)} with a reason, 0 recurring patterns",
        )
    newest_amendment = newest_filed_at(load_room("system_amendments"))
    if newest_amendment is None or days_since(newest_amendment) > 8:
        return EvalResult(
            name="flywheel.compression_yield",
            status=FAIL,
            detail=f"{len(patterns)} recurring pattern(s) in 7d but no amendment "
            "drawer written in 8d — nightly compression is not converting",
        )
    return EvalResult(
        name="flywheel.compression_yield",
        status=PASS,
        detail=f"{len(patterns)} pattern(s), newest amendment "
        f"{days_since(newest_amendment):.1f}d old",
    )


def check_amendment_rot() -> EvalResult:
    """Amendments must not rot in PENDING — an unreviewed proposal improves nothing.

    Measured as a COUNT of pending amendments older than 30d (not the age of
    the oldest, which mechanically grows daily and would ratchet-alarm on the
    calendar instead of on behavior).
    """
    import re as _re

    pending_ages = []
    for drawer in load_room("system_amendments", include_content=True):
        content = drawer.get("content") or ""
        if "status: PENDING" not in content and '"status": "PENDING"' not in content:
            continue
        # Age by proposed_date from the RECORD, not the drawer's filed_at — a
        # status-flip or migration rewrite re-stamps filed_at, which would let
        # rot hide behind mere drawer churn.
        match = _re.search(r'"proposed_date":\s*"([^"]+)"', content) or _re.search(
            r"proposed_date:\s*(\S+)", content
        )
        age = days_since(match.group(1)) if match else days_since(drawer.get("filed_at"))
        pending_ages.append(age)
    rotten = sum(1 for age in pending_ages if age is not None and age > 30)
    return EvalResult(
        name="flywheel.amendment_rot",
        status=PASS,
        value=float(rotten),
        direction=DOWN_GOOD,
        unit="count",
        detail=f"{rotten} of {len(pending_ages)} pending amendments older than 30d "
        "(aged by proposed_date)",
    )


def check_session_brief() -> EvalResult:
    """Recall must reach a context window: SESSION_BRIEF.md fresh when sessions run."""
    latest_session = _latest_session_start()
    if latest_session is None or days_since(latest_session) > SESSION_RECENT_DAYS:
        raise EvalSkip(f"no sessions in the last {SESSION_RECENT_DAYS}d")
    brief = REPO_ROOT / ".penny" / "SESSION_BRIEF.md"
    if not brief.is_file():
        return EvalResult(
            name="flywheel.session_brief",
            status=FAIL,
            detail=".penny/SESSION_BRIEF.md missing while sessions are active — "
            "recall is not being injected",
        )
    age = days_since(brief.stat().st_mtime)
    if age is not None and age > 3:
        return EvalResult(
            name="flywheel.session_brief",
            status=FAIL,
            value=age,
            direction=DOWN_GOOD,
            unit="days",
            detail=f"SESSION_BRIEF.md is {age:.1f}d stale despite recent sessions",
        )
    return EvalResult(
        name="flywheel.session_brief",
        status=PASS,
        value=age,
        direction=DOWN_GOOD,
        unit="days",
        detail=f"brief refreshed {age:.1f}d ago",
    )


def check_obs_run_ingest() -> EvalResult:
    """Engine runs must reach the observability store (fire-and-forget ≠ delivered)."""
    local = query_db(orch_db_path(), "SELECT run_id, created_at FROM runs")
    cutoff = now_utc() - timedelta(days=TERMINAL_WINDOW_DAYS)
    recent = [r for r in local if (parse_when(r["created_at"]) or cutoff) > cutoff]
    if not recent:
        raise EvalSkip(f"no engine runs in the last {TERMINAL_WINDOW_DAYS}d")
    ingested = {
        row["run_id"] for row in query_db(obs_db_path(), "SELECT run_id FROM orchestration_runs")
    }
    missing = [r["run_id"] for r in recent if r["run_id"] not in ingested]
    ratio = 1.0 - len(missing) / len(recent)
    if missing:
        return EvalResult(
            name="flywheel.obs_run_ingest",
            status=FAIL,
            value=ratio,
            direction=UP_GOOD,
            unit="fraction",
            detail=f"{len(missing)}/{len(recent)} local runs never reached observability: "
            + ", ".join(missing[:5]),
        )
    return EvalResult(
        name="flywheel.obs_run_ingest",
        status=PASS,
        value=1.0,
        direction=UP_GOOD,
        unit="fraction",
        detail=f"all {len(recent)} runs ingested",
    )


def check_outcomes_written_7d() -> EvalResult:
    """The ledger must be RECEIVING outcomes while Penny is in use.

    The engine terminal-state writer rarely fires in practice; the ledger now
    flows from `make rate` (human) and auto_capture (judge). If sessions are
    active but ZERO outcomes landed in 7d, every source seam is dead again —
    the exact silent-death this suite exists to catch. Counts at the destination
    store; does not gate on volume (more is not better), only on liveness.
    """
    latest_session = _latest_session_start()
    if latest_session is None or days_since(latest_session) > SESSION_RECENT_DAYS:
        raise EvalSkip(f"no sessions in the last {SESSION_RECENT_DAYS}d — nothing to capture")
    recent = load_outcomes(window_days=7)
    if not recent:
        return EvalResult(
            name="flywheel.outcomes_written_7d",
            status=FAIL,
            detail="sessions are active but 0 outcomes written in 7d — the capture "
            "source is dead (run `make auto-capture` / `make rate`, check the cron)",
        )
    by_source: Dict[str, int] = {}
    for o in recent:
        by_source[str(o.get("source") or "engine")] = (
            by_source.get(str(o.get("source") or "engine"), 0) + 1
        )
    breakdown = ", ".join(f"{k}:{v}" for k, v in sorted(by_source.items()))
    return EvalResult(
        name="flywheel.outcomes_written_7d",
        status=PASS,
        detail=f"{len(recent)} outcome(s) in 7d ({breakdown}) — ledger is flowing",
    )


def check_human_ratings_7d() -> EvalResult:
    """Context: how many outcomes carry a human verdict (source=human_rating) in
    7d. Informational — humans rate at their own pace; this never gates."""
    recent = load_outcomes(window_days=7)
    human = sum(1 for o in recent if str(o.get("source")) == "human_rating")
    return EvalResult(
        name="flywheel.human_ratings_7d",
        status=PASS,
        value=float(human),
        unit="count",
        informational=True,
        detail=f"{human} human-rated outcome(s) in 7d (the highest-signal label; "
        "`make rate` to add more)",
    )


def check_amendments_applied_30d() -> EvalResult:
    """Context: amendments APPLIED (not merely created) in 30d. `amendments_created`
    is an anti-metric; an applied amendment is the only one that changed anything.
    Informational — the loop may legitimately propose nothing."""
    applied = 0
    for drawer in load_room("system_amendments", include_content=True):
        content = drawer.get("content") or ""
        if ("status: APPLIED" in content or '"status": "APPLIED"' in content) and (
            (days_since(drawer.get("filed_at")) or 999) <= 30
        ):
            applied += 1
    return EvalResult(
        name="flywheel.amendments_applied_30d",
        status=PASS,
        value=float(applied),
        unit="count",
        informational=True,
        detail=f"{applied} amendment(s) applied in 30d",
    )


def check_watcher_cron_alive() -> EvalResult:
    """The ambient watcher cron must actually be executing (log heartbeat)."""
    rows = query_db(obs_db_path(), "SELECT MAX(timestamp) AS latest FROM watcher_logs")
    latest = parse_when(rows[0]["latest"]) if rows and rows[0]["latest"] else None
    age = days_since(latest) if latest else None
    if age is None or age > 2:
        return EvalResult(
            name="flywheel.watcher_cron_alive",
            status=FAIL,
            value=age,
            direction=DOWN_GOOD,
            unit="days",
            detail="no watcher log entries in 2d — ambient cron not running or not logging",
        )
    return EvalResult(
        name="flywheel.watcher_cron_alive",
        status=PASS,
        value=age,
        direction=DOWN_GOOD,
        unit="days",
        detail=f"last watcher log {age:.2f}d ago",
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("flywheel.outcome_capture", check_outcome_capture),
    ("flywheel.diary_delivery", check_diary_delivery),
    ("flywheel.autodiary_skips_7d", check_autodiary_skips),
    ("flywheel.archiver_backlog", check_archiver_backlog),
    ("flywheel.active_rooms_have_ttl", check_active_rooms_have_ttl),
    ("flywheel.compression_yield", check_compression_yield),
    ("flywheel.amendment_rot", check_amendment_rot),
    ("flywheel.outcomes_written_7d", check_outcomes_written_7d),
    ("flywheel.human_ratings_7d", check_human_ratings_7d),
    ("flywheel.amendments_applied_30d", check_amendments_applied_30d),
    ("flywheel.session_brief", check_session_brief),
    ("flywheel.obs_run_ingest", check_obs_run_ingest),
    ("flywheel.watcher_cron_alive", check_watcher_cron_alive),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
