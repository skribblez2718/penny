"""Per-domain trust — earned from the outcome ledger, never granted by default.

Trust answers: "given this domain's recent track record, how confident are we
that an unattended action here will succeed?" It is the evidence half of the
act-vs-ask gate (the reversibility half is action_classes.py).

Properties the design demands:
  * Starts at ZERO. No outcomes → no trust → always ask. Trust is earned.
  * Low sample size caps trust low — you can't trust a domain on 2 data points.
  * A recent MISMATCH decays trust HARD (asymmetric: slow to earn, fast to lose)
    via exponential recency weighting — a failure yesterday outweighs successes
    from a month ago.
  * Trust is CAPPED by the verifier's false-pass rate (from the judgment eval).
    You cannot be more confident in unattended work than your ability to catch
    it being wrong — the safety coupling that makes autonomy honest.

Trust is keyed on the ledger's `domain` field (coding/research/planning/…), the
granularity the outcomes actually carry. The gate combines domain trust with the
per-action reversibility tag.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# A MATCH from RECENCY_HALFLIFE_DAYS ago counts half as much as one today. Short
# enough that a recent failure dominates stale successes.
RECENCY_HALFLIFE_DAYS = 14.0
# Trust is confidence-scaled: below this many (recency-weighted) evaluated
# outcomes, trust is capped proportionally — no full trust from a thin record.
FULL_SAMPLE = 8.0
# PARTIAL counts as a half-success.
_SCORE = {"MATCH": 1.0, "PARTIAL": 0.5, "MISMATCH": 0.0}
# Asymmetry: "slow to earn, fast to lose." A MISMATCH counts as this many
# failures in the rate, so ONE recent failure among a handful of successes pulls
# trust back below the act threshold — the design's hard-decay requirement.
FAILURE_WEIGHT = 3.0


@dataclass(frozen=True)
class TrustScore:
    domain: str
    trust: float  # [0, 1]
    n: int  # evaluated outcomes in scope
    weighted_match_rate: float  # recency-weighted success rate before capping
    effective_sample: float  # recency-weighted count (drives the confidence cap)
    false_pass_cap: float  # the verifier-reliability ceiling applied


def _parse_when(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def compute_trust(
    outcomes: List[Dict[str, Any]],
    domain: str,
    now: Optional[datetime] = None,
    false_pass_rate: Optional[float] = None,
) -> TrustScore:
    """Trust for one domain from its evaluated outcomes.

    ``false_pass_rate`` (0..1) from the calibrated verifier caps trust at
    ``1 - false_pass_rate``; None means uncapped (no verifier signal yet).
    """
    now = now or datetime.now(timezone.utc)
    scored = [
        o
        for o in outcomes
        if str(o.get("domain")) == domain
        and str(o.get("delta_score") or o.get("outcome") or "").upper() in _SCORE
    ]
    if not scored:
        return TrustScore(domain, 0.0, 0, 0.0, 0.0, _cap(false_pass_rate))

    total_w = 0.0  # for the confidence cap: raw recency-weighted evidence
    rate_denom = 0.0  # for the rate: failures weighted heavier (asymmetry)
    match_w = 0.0
    for o in scored:
        when = _parse_when(o.get("timestamp"))
        age_days = (
            max(0.0, (now - when).total_seconds() / 86400.0) if when else RECENCY_HALFLIFE_DAYS
        )
        weight = 0.5 ** (age_days / RECENCY_HALFLIFE_DAYS)
        verdict = str(o.get("delta_score") or o.get("outcome") or "").upper()
        penalty = FAILURE_WEIGHT if verdict == "MISMATCH" else 1.0
        total_w += weight
        rate_denom += weight * penalty
        match_w += weight * penalty * _SCORE[verdict]  # MISMATCH scores 0 either way

    weighted_rate = match_w / rate_denom if rate_denom else 0.0
    confidence = min(1.0, total_w / FULL_SAMPLE)  # thin record → low confidence
    cap = _cap(false_pass_rate)
    trust = min(weighted_rate * confidence, cap)
    return TrustScore(
        domain=domain,
        trust=round(trust, 4),
        n=len(scored),
        weighted_match_rate=round(weighted_rate, 4),
        effective_sample=round(total_w, 3),
        false_pass_cap=round(cap, 4),
    )


def _cap(false_pass_rate: Optional[float]) -> float:
    if false_pass_rate is None or not math.isfinite(false_pass_rate):
        return 1.0
    return max(0.0, min(1.0, 1.0 - false_pass_rate))


def trust_by_domain(
    outcomes: List[Dict[str, Any]],
    domains: List[str],
    now: Optional[datetime] = None,
    false_pass_rate: Optional[float] = None,
) -> Dict[str, TrustScore]:
    return {d: compute_trust(outcomes, d, now, false_pass_rate) for d in domains}


# ── live-store adapters (thin; the math above is pure + tested) ──────────────


def load_ledger_outcomes(window_days: float = 90.0) -> List[Dict[str, Any]]:
    """Recent outcomes from the live ledger (best-effort; [] on any failure)."""
    try:
        from pathlib import Path
        import sys

        evals = str(Path(__file__).resolve().parents[1] / "evals")
        if evals not in sys.path:
            sys.path.insert(0, evals)
        from eval_lib import load_outcomes  # type: ignore[import-not-found]

        return load_outcomes(window_days=window_days)
    except Exception:  # noqa: BLE001
        return []


def load_verifier_false_pass() -> Optional[float]:
    """The best judge's false-pass rate from the latest judgment artifact, or None.

    This is the safety cap: trust can never exceed the verifier's reliability.
    """
    try:
        from pathlib import Path
        import json

        latest = (
            Path(__file__).resolve().parents[3] / ".penny" / "evals" / "judgment" / "latest.json"
        )
        data = json.loads(latest.read_text(encoding="utf-8"))
        per_model = data.get("per_model", {})
        best = None
        for s in per_model.values():
            if isinstance(s, dict) and s.get("n") and s.get("false_pass_rate") is not None:
                if best is None or s["agreement"] > best[0]:
                    best = (s["agreement"], s["false_pass_rate"])
        return best[1] if best else None
    except Exception:  # noqa: BLE001
        return None
