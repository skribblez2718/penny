"""V12 repayment: measure what CODE catches, so the cross-model default is a decision
made on evidence rather than on the appeal of "two models must be better than one".

The harness runs the two deterministic layers over the labelled corpus:
  1. the IDEAL_STATE schema validator (scripts/validate_ideal_state.py), and
  2. item 11's ``artifact_facts`` -> ``hard_contradictions`` rules floor.

No model is called. That is the point: every defect code catches is one for which a
second model's opinion is irrelevant, so the population that could justify paying for
cross-model validation on every run is exactly the judgement-tier residual.

These tests are also a RATCHET: if a rules-tier defect stops being caught, the floor has
regressed; if a judgement-tier defect starts being caught by code, that is good news and
the case should be re-labelled (the assertion fails loudly so the corpus can't silently rot).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from orchestration.playbooks.prd import artifact_facts, hard_contradictions

from prd_defect_corpus import CORPUS, DefectCase, by_tier

_SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from validate_ideal_state import validate_json  # noqa: E402


def _code_catches(case: DefectCase) -> tuple[bool, list[str]]:
    """Run every deterministic layer over a case. Returns (caught, reasons)."""
    reasons: list[str] = []
    ok, errors = validate_json(case.ideal)
    if not ok:
        reasons += [f"schema: {e}" for e in errors]
    facts = artifact_facts(
        narrative=case.narrative,
        catalog=case.catalog or None,
        matrix=case.matrix or None,
        ideal=case.ideal,
        declared=set(range(1, 13)),
    )
    reasons += hard_contradictions(facts)
    return bool(reasons), reasons


# ---------------------------------------------------------------------------
# the ratchet
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", by_tier("rules"), ids=lambda c: c.id)
def test_rules_tier_defects_are_caught_by_code(case):
    caught, reasons = _code_catches(case)
    assert caught, (
        f"RULES-tier defect '{case.id}' is no longer caught deterministically "
        f"({case.description}). The floor has regressed — a second model cannot be the "
        f"answer to an objective, countable defect."
    )


@pytest.mark.parametrize("case", by_tier("judgement"), ids=lambda c: c.id)
def test_judgement_tier_defects_are_not_caught_by_code(case):
    caught, reasons = _code_catches(case)
    assert not caught, (
        f"JUDGEMENT-tier defect '{case.id}' is NOW caught by code ({reasons}). That is an "
        f"improvement — re-label the case as tier='rules' so the measurement stays honest."
    )


def test_corpus_is_grounded_in_observed_failures():
    observed = [c.id for c in CORPUS if c.observed]
    assert observed, "the corpus must contain at least one defect seen in a real run"


# ---------------------------------------------------------------------------
# the measurement that decides the V12 default
# ---------------------------------------------------------------------------


def test_report_deterministic_coverage(capsys):
    rules = by_tier("rules")
    judgement = by_tier("judgement")
    total = len(CORPUS)
    caught = sum(1 for c in CORPUS if _code_catches(c)[0])

    with capsys.disabled():
        print("\n  ── V12 measurement: what deterministic code already catches ──")
        print(f"  corpus size ................ {total}")
        print(f"  caught by code ............. {caught}/{total} ({100 * caught // total}%)")
        print(f"  rules tier (code decides) .. {len(rules)}")
        print(f"  judgement residual ......... {len(judgement)} "
              f"({100 * len(judgement) // total}% of the corpus)")
        print("  → cross-model validation can only affect the judgement residual;")
        print("    it adds nothing to defects the floor already decides.")

    # The floor must decide every rules-tier case and no judgement-tier case.
    assert caught == len(rules)
