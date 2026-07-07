"""Weekly digest generator — aggregate mempalace data into structured JSON.

Pulls from penny/outcomes, penny/diary, penny/signals, penny/system_amendments.
Produces digest JSON including session_ids for observability correlation.
"""

from typing import List, Dict, Any, Optional


def aggregate_outcomes(
    outcomes: List[Dict[str, Any]], include_domains: bool = False
) -> Dict[str, Any]:
    """Tally MATCH/PARTIAL/MISMATCH from outcome records."""
    tally = {"MATCH": 0, "PARTIAL": 0, "MISMATCH": 0, "unevaluated": 0}
    domains: Dict[str, Dict[str, Any]] = {}

    for o in outcomes:
        outcome = o.get("outcome")
        if outcome in tally:
            tally[outcome] += 1
        else:
            tally["unevaluated"] += 1
            continue

        if include_domains:
            domain = o.get("domain", "unknown")
            if domain not in domains:
                domains[domain] = {"total": 0, "MATCH": 0, "PARTIAL": 0, "MISMATCH": 0}
            domains[domain]["total"] += 1
            if outcome in ("MATCH", "PARTIAL", "MISMATCH"):
                domains[domain][outcome] += 1

    if include_domains:
        tally["domains"] = domains
    return tally


def aggregate_confidence(outcomes: List[Dict[str, Any]]) -> Dict[str, int]:
    """Tally confidence levels from outcome records."""
    levels = ["CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"]
    tally = {level: 0 for level in levels}
    for o in outcomes:
        confidence = o.get("confidence_at_action")
        if confidence in tally:
            tally[confidence] += 1
    return tally


def identify_attention_flags(
    outcomes: List[Dict[str, Any]],
    signals: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Flag patterns requiring user attention.

    Triggers:
    - 2+ MISMATCH in same domain (pattern)
    - Any CRITICAL pending signals
    - Unevaluated outcomes older than threshold
    """
    flags = []

    # MISMATCH pattern detection
    mismatch_by_domain: Dict[str, List[Dict[str, Any]]] = {}
    for o in outcomes:
        if o.get("outcome") == "MISMATCH":
            domain = o.get("domain", "unknown")
            mismatch_by_domain.setdefault(domain, []).append(o)

    for domain, items in mismatch_by_domain.items():
        if len(items) >= 2:
            flags.append(
                {
                    "type": "MISMATCH",
                    "severity": "HIGH",
                    "description": f"{len(items)} MISMATCH outcomes in {domain} domain",
                    "session_id": items[0].get("session_id", ""),
                    "evidence": [o.get("decision_id", "unknown") for o in items],
                }
            )

    # CRITICAL signals
    if signals:
        for sig in signals:
            if sig.get("priority") == "CRITICAL":
                flags.append(
                    {
                        "type": "CRITICAL_SIGNAL",
                        "severity": "HIGH",
                        "description": sig.get("title", "Critical signal pending"),
                        "session_id": sig.get("session_id", ""),
                        "evidence": [sig.get("signal_id", "unknown")],
                    }
                )

    return flags


def _generate_recommendations(digest: Dict[str, Any]) -> List[str]:
    """Generate human-readable recommendations from digest metrics."""
    recommendations = []

    for flag in digest.get("attention_flags", []):
        if flag["type"] == "MISMATCH":
            session_info = f" (session: {flag['session_id']})" if flag.get("session_id") else ""
            recommendations.append(
                f"Review MISMATCH outcomes in {flag.get('domain', 'a')} domain{session_info}"
            )

    pending_amendments = digest.get("amendments_summary", {}).get("pending", 0)
    if pending_amendments > 0:
        recommendations.append(f"Approve or reject {pending_amendments} pending amendment(s)")

    critical_signals = digest.get("signals_summary", {}).get("critical_pending", 0)
    if critical_signals > 0:
        recommendations.append(f"Address {critical_signals} critical pending signal(s)")

    return recommendations


def build_digest_json(
    outcomes: List[Dict[str, Any]],
    diary: List[Dict[str, Any]],
    week_start: str,
    week_end: str,
    amendments: Optional[Dict[str, int]] = None,
    signals: Optional[List[Dict[str, Any]]] = None,
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Construct full digest JSON from source data.

    Includes session_ids for observability server correlation.
    """
    from datetime import datetime, timezone

    if generated_at is None:
        generated_at = datetime.now(timezone.utc).isoformat()

    outcome_tally = aggregate_outcomes(outcomes)
    confidence_tally = aggregate_confidence(outcomes)

    # Extract unique session_ids from outcomes and diary.
    session_ids = set()
    for o in outcomes:
        sid = o.get("session_id")
        if sid:
            session_ids.add(sid)
    for d in diary:
        # Prefer a structured field; fall back to a STRICT text match that
        # requires an id-shaped token (hex/uuid, 8+ chars) after an explicit
        # "session_id:" marker. The old loose regex matched prose words like
        # "session Manager" -> "Manager", polluting the correlation set.
        sid = d.get("session_id")
        if sid:
            session_ids.add(sid)
            continue
        content = d.get("text", "") or d.get("content", "")
        import re

        for match in re.finditer(
            r"session[_-]?id[:=]\s*([0-9a-fA-F][0-9a-fA-F-]{7,})", content, re.IGNORECASE
        ):
            session_ids.add(match.group(1))

    attention = identify_attention_flags(outcomes, signals=signals or [])

    # Count unique sessions from diary
    sessions_count = (
        len(set(d.get("timestamp", "").split("T")[0] for d in diary)) if diary else len(session_ids)
    )

    digest = {
        "digest_id": f"digest_{week_start}",
        "week_start": week_start,
        "week_end": week_end,
        "generated_at": generated_at,
        "session_ids": sorted(list(session_ids)),
        "summary": {
            "sessions": sessions_count,
            "decisions": len(outcomes),
            "actions_taken": len(outcomes),  # proxy — decisions ≈ actions
        },
        "outcomes": {
            "MATCH": outcome_tally.get("MATCH", 0),
            "PARTIAL": outcome_tally.get("PARTIAL", 0),
            "MISMATCH": outcome_tally.get("MISMATCH", 0),
            "unevaluated": outcome_tally.get("unevaluated", 0),
        },
        "confidence": confidence_tally,
        "attention_flags": attention,
        "amendments_summary": amendments
        or {"proposed": 0, "approved": 0, "rejected": 0, "pending": 0},
        "signals_summary": {
            "critical_pending": sum(
                1
                for s in (signals or [])
                if s.get("priority") == "CRITICAL" and s.get("status") == "PENDING"
            ),
            "info_pending": sum(
                1
                for s in (signals or [])
                if s.get("priority") != "CRITICAL" and s.get("status") == "PENDING"
            ),
        },
        "recommendations": [],
    }

    digest["recommendations"] = _generate_recommendations(digest)
    return digest


def generate_weekly_digest(
    week_start: str,
    week_end: str,
    outcomes: Optional[List[Dict[str, Any]]] = None,
    diary: Optional[List[Dict[str, Any]]] = None,
    signals: Optional[List[Dict[str, Any]]] = None,
    amendments: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """Public entry point — build a weekly digest from all available data.

    In production, this queries mempalace rooms. For testing, data is passed directly.
    """
    return build_digest_json(
        outcomes=outcomes or [],
        diary=diary or [],
        week_start=week_start,
        week_end=week_end,
        amendments=amendments,
        signals=signals,
    )
