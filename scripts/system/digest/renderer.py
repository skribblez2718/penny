"""Render digest JSON to markdown for human presentation."""

from typing import Dict, Any, List


def _safe_percent(numerator: int, denominator: int) -> str:
    if denominator == 0:
        return "0%"
    return f"{(numerator / denominator) * 100:.0f}%"


def render_digest_markdown(digest: Dict[str, Any]) -> str:
    """Render structured digest JSON to human-readable markdown."""
    lines: List[str] = []
    week = digest.get("week_start", "Unknown week")

    lines.append(f"# Penny Weekly Digest — Week of {week}")
    lines.append("")

    # Summary
    summary = digest.get("summary", {})
    lines.append("## Summary")
    lines.append(f"- Sessions: {summary.get('sessions', 0)}")
    lines.append(f"- Decisions made: {summary.get('decisions', 0)}")
    lines.append(f"- Actions taken: {summary.get('actions_taken', 0)}")
    lines.append("")

    # Outcomes
    outcomes = digest.get("outcomes", {})
    total_evaluated = outcomes.get("MATCH", 0) + outcomes.get("PARTIAL", 0) + outcomes.get("MISMATCH", 0)
    lines.append("## Outcomes")
    lines.append(f"- MATCH: {outcomes.get('MATCH', 0)} ({_safe_percent(outcomes.get('MATCH', 0), total_evaluated)})")
    lines.append(f"- PARTIAL: {outcomes.get('PARTIAL', 0)} ({_safe_percent(outcomes.get('PARTIAL', 0), total_evaluated)})")
    lines.append(f"- MISMATCH: {outcomes.get('MISMATCH', 0)} ({_safe_percent(outcomes.get('MISMATCH', 0), total_evaluated)})")
    lines.append("")

    # Confidence
    confidence = digest.get("confidence", {})
    total_conf = sum(confidence.values())
    if total_conf > 0:
        lines.append("## Confidence Distribution")
        for level in ["CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"]:
            count = confidence.get(level, 0)
            if count > 0:
                lines.append(f"- {level}: {count} ({_safe_percent(count, total_conf)})")
        lines.append("")

    # Attention flags
    flags = digest.get("attention_flags", [])
    if flags:
        lines.append("## ⚠️ Attention Flags")
        for flag in flags:
            session_info = f" (session: {flag.get('session_id')})" if flag.get("session_id") else ""
            lines.append(f"- **{flag['type']}**: {flag['description']}{session_info}")
        lines.append("")

    # Amendments
    amendments = digest.get("amendments_summary", {})
    if any(v > 0 for v in amendments.values()):
        lines.append("## 📝 Amendments")
        lines.append(
            f"- Proposed: {amendments.get('proposed', 0)} | "
            f"Approved: {amendments.get('approved', 0)} | "
            f"Rejected: {amendments.get('rejected', 0)} | "
            f"Pending: {amendments.get('pending', 0)}"
        )
        lines.append("")

    # Signals
    signals = digest.get("signals_summary", {})
    if signals.get("critical_pending", 0) > 0 or signals.get("info_pending", 0) > 0:
        lines.append("## 📋 Pending Signals")
        if signals.get("critical_pending", 0) > 0:
            lines.append(f"- Critical: {signals['critical_pending']}")
        if signals.get("info_pending", 0) > 0:
            lines.append(f"- Info: {signals['info_pending']}")
        lines.append("")

    # Recommendations
    recommendations = digest.get("recommendations", [])
    if recommendations:
        lines.append("## Recommendations")
        for i, rec in enumerate(recommendations, 1):
            lines.append(f"{i}. {rec}")
        lines.append("")

    # Session IDs for observability correlation
    session_ids = digest.get("session_ids", [])
    if session_ids:
        lines.append("---")
        lines.append(f"*Correlation IDs: {', '.join(session_ids)}*")
        lines.append("")

    return "\n".join(lines)
