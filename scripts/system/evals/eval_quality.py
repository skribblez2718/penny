"""Outcome quality — does Penny actually get better at the work?

These read the FULL content of ``penny/outcomes`` via the bridge (not the
lossy 200-char-summary/limit-50 path the ambient watcher uses) and compute the
metrics that define "better": mistakes not repeating, confidence meaning
something, runs finishing. Volume counters are reported but never gated —
they are the proxies this suite exists to displace.

Most checks SKIP below a minimum sample size: a rate computed over three
records is noise, and ratcheting noise trains the baseline on luck.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any, Callable, Dict, List, Tuple

from eval_lib import (
    DOWN_GOOD,
    HIGH_CONFIDENCE,
    LOW_CONFIDENCE,
    PASS,
    SUBOPTIMAL,
    UP_GOOD,
    EvalResult,
    EvalSkip,
    load_outcomes,
    load_room,
    normalize_reason,
    now_utc,
    orch_db_path,
    parse_when,
    query_db,
    run_checks,
)

MIN_SAMPLE = 5
MIN_MISMATCHES = 3
MIN_RUNS = 3


def check_outcome_volume() -> EvalResult:
    """Reported for context only. Volume is an anti-metric: never gate on it."""
    count = len(load_outcomes(window_days=30))
    return EvalResult(
        name="quality.outcome_volume_30d",
        status=PASS,
        value=float(count),
        unit="count",
        informational=True,
        detail="context only — more outcomes is not better, it is just more",
    )


def check_mismatch_rate() -> EvalResult:
    """Share of evaluated outcomes that MISMATCHed in the last 30d."""
    outcomes = load_outcomes(window_days=30)
    evaluated = [o for o in outcomes if o.get("outcome") in ("MATCH", "PARTIAL", "MISMATCH")]
    if len(evaluated) < MIN_SAMPLE:
        raise EvalSkip(f"only {len(evaluated)} evaluated outcomes in 30d (need {MIN_SAMPLE})")
    rate = sum(1 for o in evaluated if o["outcome"] == "MISMATCH") / len(evaluated)
    return EvalResult(
        name="quality.mismatch_rate_30d",
        status=PASS,
        value=round(rate, 4),
        direction=DOWN_GOOD,
        unit="fraction",
        detail=f"{len(evaluated)} evaluated outcomes",
    )


def check_repeat_mismatch_rate() -> EvalResult:
    """THE self-improvement metric: how often is a mistake a repeat of an old one?

    A MISMATCH counts as a repeat when an earlier suboptimal outcome (≥3 days
    older) shares its domain and failure signature. If the learning loop works,
    this trends to zero even while new (first-time) mistakes still happen.
    """
    outcomes = [o for o in load_outcomes(window_days=90) if o.get("_when") is not None]
    mismatches = [o for o in outcomes if o.get("outcome") == "MISMATCH"]
    if len(mismatches) < MIN_MISMATCHES:
        raise EvalSkip(f"only {len(mismatches)} MISMATCH outcomes in 90d (need {MIN_MISMATCHES})")

    suboptimal = [o for o in outcomes if o.get("outcome") in SUBOPTIMAL]
    repeats = 0
    scored = 0
    for record in mismatches:
        signature = normalize_reason(record)
        if not signature:
            continue
        scored += 1
        for earlier in suboptimal:
            if earlier is record:
                continue
            gap = (record["_when"] - earlier["_when"]).total_seconds() / 86400.0
            if gap < 3:
                continue
            if (
                str(earlier.get("domain") or "") == str(record.get("domain") or "")
                and normalize_reason(earlier) == signature
            ):
                repeats += 1
                break
    if scored == 0:
        raise EvalSkip("no MISMATCH carries a usable failure signature (reason field empty)")
    rate = repeats / scored
    return EvalResult(
        name="quality.repeat_mismatch_rate_90d",
        status=PASS,
        value=round(rate, 4),
        direction=DOWN_GOOD,
        unit="fraction",
        detail=f"{repeats}/{scored} signed MISMATCHes repeat an earlier failure "
        f"({len(mismatches) - scored} unsigned)",
    )


def check_confidence_populated() -> EvalResult:
    """Calibration is impossible if confidence_at_action is blank at write time."""
    outcomes = load_outcomes(window_days=30)
    if len(outcomes) < MIN_SAMPLE:
        raise EvalSkip(f"only {len(outcomes)} outcomes in 30d (need {MIN_SAMPLE})")
    populated = sum(
        1
        for o in outcomes
        if str(o.get("confidence_at_action") or "").strip().upper()
        in HIGH_CONFIDENCE + LOW_CONFIDENCE
    )
    rate = populated / len(outcomes)
    return EvalResult(
        name="quality.confidence_populated_30d",
        status=PASS,
        value=round(rate, 4),
        direction=UP_GOOD,
        unit="fraction",
        detail=f"{populated}/{len(outcomes)} outcomes carry a canonical confidence level",
    )


def check_calibration_gap() -> EvalResult:
    """Declared confidence must predict outcomes: P(MATCH|high) − P(MATCH|low) > 0.

    If CERTAIN/PROBABLE actions succeed no more often than POSSIBLE/UNCERTAIN
    ones, the confidence vocabulary is decoration, not information.
    """
    outcomes = [
        o
        for o in load_outcomes(window_days=90)
        if o.get("outcome") in ("MATCH", "PARTIAL", "MISMATCH")
    ]
    high = [
        o
        for o in outcomes
        if str(o.get("confidence_at_action") or "").strip().upper() in HIGH_CONFIDENCE
    ]
    low = [
        o
        for o in outcomes
        if str(o.get("confidence_at_action") or "").strip().upper() in LOW_CONFIDENCE
    ]
    if len(high) < MIN_SAMPLE or len(low) < MIN_SAMPLE:
        raise EvalSkip(
            f"need {MIN_SAMPLE}+ outcomes per confidence bucket (high={len(high)}, "
            f"low={len(low)})"
        )
    p_high = sum(1 for o in high if o["outcome"] == "MATCH") / len(high)
    p_low = sum(1 for o in low if o["outcome"] == "MATCH") / len(low)
    gap = p_high - p_low
    return EvalResult(
        name="quality.calibration_gap_90d",
        status=PASS,
        value=round(gap, 4),
        direction=UP_GOOD,
        unit="fraction",
        detail=f"P(MATCH|high)={p_high:.2f} (n={len(high)}), "
        f"P(MATCH|low)={p_low:.2f} (n={len(low)})",
    )


def _applied_amendments() -> List[Dict[str, Any]]:
    """APPLIED amendments with an applied_date, parsed from their drawers."""
    applied = []
    for drawer in load_room("system_amendments", include_content=True):
        text = drawer.get("content") or ""
        lines = text.splitlines()
        body = "\n".join(lines[1:]) if lines and lines[0].startswith("amendment_id:") else text
        try:
            record = json.loads(body)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(record, dict)
            and record.get("status") == "APPLIED"
            and parse_when(record.get("applied_date")) is not None
        ):
            applied.append(record)
    return applied


def check_amendment_efficacy() -> EvalResult:
    """Did applying an amendment actually reduce failures in its domain?

    For each APPLIED amendment: suboptimal (MISMATCH+PARTIAL) rate in its
    domain over the 30d before applied_date minus the 30d after. Positive mean
    = amendments help. This is the check that turns "we changed a prompt"
    into "we know whether it helped" — without it the improvement pipeline
    optimizes proposal volume.
    """
    applied = _applied_amendments()
    if not applied:
        raise EvalSkip("no APPLIED amendments yet — the loop has not closed once")
    outcomes = [
        o
        for o in load_outcomes()
        if o.get("outcome") in ("MATCH", "PARTIAL", "MISMATCH") and o.get("_when")
    ]
    deltas = []
    thin = 0
    unattributable = 0
    for amendment in applied:
        cut = parse_when(amendment["applied_date"])
        domain = str(amendment.get("domain") or "").lower()
        if not domain:
            # A domain-less amendment would be measured against ALL outcomes,
            # attributing any global rate shift to this one change — a lucky
            # window would then ratchet the baseline to a value amendments
            # can't reproduce. Skip it rather than fake attribution.
            unattributable += 1
            continue
        pool = [o for o in outcomes if str(o.get("domain") or "").lower() == domain]
        window = timedelta(days=30)
        before = [o for o in pool if cut - window <= o["_when"] < cut]
        after = [o for o in pool if cut < o["_when"] <= cut + window]
        if len(before) < MIN_MISMATCHES or len(after) < MIN_MISMATCHES:
            thin += 1
            continue

        def _suboptimal_rate(records: List[Dict[str, Any]]) -> float:
            return sum(1 for o in records if o["outcome"] in SUBOPTIMAL) / len(records)

        deltas.append(_suboptimal_rate(before) - _suboptimal_rate(after))
    if not deltas:
        raise EvalSkip(
            f"{len(applied)} APPLIED amendment(s) but not enough before/after outcomes "
            f"({thin} with thin windows, {unattributable} without a domain) — "
            "efficacy measurable once outcomes accrue"
        )
    mean_delta = sum(deltas) / len(deltas)
    return EvalResult(
        name="quality.amendment_efficacy",
        status=PASS,
        value=round(mean_delta, 4),
        direction=UP_GOOD,
        unit="fraction",
        detail=f"mean suboptimal-rate drop across {len(deltas)} applied amendment(s) "
        f"({thin} skipped for thin windows, {unattributable} without a domain); "
        "positive = amendments help",
    )


def check_run_completion() -> EvalResult:
    """Terminal engine runs should end complete (and met), not error out."""
    rows = query_db(
        orch_db_path(),
        "SELECT status, context_json, updated_at FROM runs "
        "WHERE status IN ('complete', 'error')",
    )
    cutoff = now_utc() - timedelta(days=30)
    recent = [r for r in rows if (parse_when(r["updated_at"]) or cutoff) > cutoff]
    if len(recent) < MIN_RUNS:
        raise EvalSkip(f"only {len(recent)} terminal runs in 30d (need {MIN_RUNS})")
    completed = sum(1 for r in recent if r["status"] == "complete")
    rate = completed / len(recent)
    return EvalResult(
        name="quality.run_completion_30d",
        status=PASS,
        value=round(rate, 4),
        direction=UP_GOOD,
        unit="fraction",
        detail=f"{completed}/{len(recent)} terminal runs completed (rest errored)",
    )


CHECKS: List[Tuple[str, Callable[[], EvalResult]]] = [
    ("quality.outcome_volume_30d", check_outcome_volume),
    ("quality.mismatch_rate_30d", check_mismatch_rate),
    ("quality.repeat_mismatch_rate_90d", check_repeat_mismatch_rate),
    ("quality.confidence_populated_30d", check_confidence_populated),
    ("quality.calibration_gap_90d", check_calibration_gap),
    ("quality.amendment_efficacy", check_amendment_efficacy),
    ("quality.run_completion_30d", check_run_completion),
]


def collect() -> List[EvalResult]:
    return run_checks(CHECKS)
