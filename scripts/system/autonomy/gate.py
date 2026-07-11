"""The act-vs-ask gate — compose reversibility + earned trust into one decision.

    if reversibility(action) in (irreversible, destructive):  ASK   # hard rule
    elif trust(domain) >= threshold and graduated(domain):    ACT   # unattended
    else:                                                     ASK

The hard rule comes FIRST and no trust score overrides it — irreversible and
destructive actions always ask, the permanent human floor. Only reversible
actions in a domain that has EARNED trust (and whose confidence actually
predicts success — the calibration graduation gate) run unattended.

This module is the composable decision; wiring it into the engine's decision
points and the questionnaire ASK path is the integration step (see the
capability doc). The logic here is pure and tested so the wiring is trivial.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, Optional

from action_classes import REVERSIBLE, classify
from trust import (
    TrustScore,
    compute_trust,
    load_ledger_outcomes,
    load_verifier_false_pass,
)

ACT = "ACT"
ASK = "ASK"

# Conservative default: a domain must be quite reliable before acting alone.
# Start high; loosen only as calibration data accumulates (per the plan).
DEFAULT_THRESHOLD = 0.75


@dataclass(frozen=True)
class Decision:
    action: str  # ACT | ASK
    reason: str
    action_class: str  # domain.operation
    reversibility: str
    trust: float


def decide(
    action_text: str,
    trust_lookup: Callable[[str], TrustScore],
    threshold: float = DEFAULT_THRESHOLD,
    graduated: Optional[Callable[[str], bool]] = None,
) -> Decision:
    """Pure decision. ``trust_lookup(domain) -> TrustScore``; ``graduated(domain)``
    (optional) is the calibration gate — a domain is eligible for ACT only when
    its confidence predicts success. Absent → treated as graduated (trust-only)."""
    cls = classify(action_text)
    # Hard rule first — no trust score overrides it. Fail-SAFE: only an
    # explicitly REVERSIBLE action is eligible to act unattended. Anything else
    # (irreversible, destructive, or an unexpected/unknown reversibility value)
    # asks — so a taxonomy gap can never silently unlock autonomy.
    if cls.reversibility != REVERSIBLE:
        return Decision(
            action=ASK,
            reason=f"{cls.reversibility} action always asks a human",
            action_class=cls.key,
            reversibility=cls.reversibility,
            trust=0.0,
        )
    score = trust_lookup(cls.domain)
    is_graduated = graduated(cls.domain) if graduated else True
    if score.trust >= threshold and is_graduated:
        return Decision(
            action=ACT,
            reason=f"reversible; {cls.domain} trust {score.trust:.0%} ≥ {threshold:.0%} "
            f"(n={score.n}, capped at {score.false_pass_cap:.0%})",
            action_class=cls.key,
            reversibility=cls.reversibility,
            trust=score.trust,
        )
    why = (
        "not yet graduated (confidence doesn't predict success)"
        if not is_graduated
        else (
            f"trust {score.trust:.0%} < {threshold:.0%}"
            + ("" if score.n else " — no history, trust is earned")
        )
    )
    return Decision(
        action=ASK,
        reason=f"reversible but {why}",
        action_class=cls.key,
        reversibility=cls.reversibility,
        trust=score.trust,
    )


def decide_live(action_text: str, threshold: float = DEFAULT_THRESHOLD) -> Decision:
    """Decision against the live ledger + verifier false-pass cap. Best-effort:
    with no data, every domain has zero trust, so everything asks (safe default)."""
    outcomes = load_ledger_outcomes()
    fp = load_verifier_false_pass()
    cache: Dict[str, TrustScore] = {}

    def lookup(domain: str) -> TrustScore:
        if domain not in cache:
            cache[domain] = compute_trust(outcomes, domain, false_pass_rate=fp)
        return cache[domain]

    return decide(action_text, lookup, threshold)
