"""Measure what CODE already decides about grounding, so the cross-model default is
a decision made on evidence rather than on the appeal of "two models beat one".

No model is called — that is the point. Every defect the deterministic floor catches
is a defect for which a second model's opinion is irrelevant, so the population that
could justify paying for cross-model validation on EVERY run is exactly the
judgement-tier residual.

These tests are also a RATCHET:
  * a rules-tier defect that stops being caught means the floor regressed;
  * a judgement-tier defect that starts being caught by code is GOOD NEWS, and the
    assertion fails loudly so the case gets re-labelled instead of the corpus quietly
    rotting into a flattering measurement.
"""

from __future__ import annotations

import pytest

from orchestration.playbooks.research import grounding_floor

from research_grounding_corpus import CORPUS, GroundingCase, by_tier, defective


def _floor_catches(case: GroundingCase) -> tuple[bool, list[str]]:
    reasons = grounding_floor(list(case.claims), list(case.sources))
    return bool(reasons), reasons


# ---------------------------------------------------------------------------
# the ratchet
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", by_tier("rules"), ids=lambda c: c.id)
def test_rules_tier_defects_are_caught_by_code(case):
    caught, _ = _floor_catches(case)
    assert caught, (
        f"RULES-tier defect '{case.id}' is no longer caught deterministically "
        f"({case.description}). The floor regressed — a second model cannot be the "
        f"answer to an objectively decidable defect."
    )


@pytest.mark.parametrize("case", by_tier("judgement"), ids=lambda c: c.id)
def test_judgement_tier_defects_are_not_caught_by_code(case):
    caught, reasons = _floor_catches(case)
    assert not caught, (
        f"JUDGEMENT-tier defect '{case.id}' is NOW caught by code ({reasons}). That is an "
        f"improvement — re-label the case tier='rules' so the measurement stays honest."
    )


def test_floor_is_silent_on_genuinely_grounded_work():
    """A floor that fires on clean work would be worse than no floor: it would train
    the pipeline to ignore it."""
    clean = next(c for c in CORPUS if c.id == "genuinely_grounded")
    caught, reasons = _floor_catches(clean)
    assert not caught, f"floor false-positived on a grounded synthesis: {reasons}"


def test_floor_names_the_offending_claim():
    """A reason must identify WHICH claim failed, or it cannot drive a revision."""
    case = next(c for c in CORPUS if c.id == "claim_with_no_citation")
    _, reasons = _floor_catches(case)
    assert any("C2" in r for r in reasons), reasons
    assert not any("C1" in r for r in reasons), f"flagged the grounded claim too: {reasons}"


def test_corpus_provenance_is_declared_honestly():
    """The corpus is currently synthetic. This test does NOT demand observed cases —
    it pins the honest statement of that fact so a future reader is not misled into
    thinking these were mined from real runs. Flip to asserting observed cases once
    P1's ledger signal has supplied them."""
    observed = [c.id for c in CORPUS if c.observed]
    assert observed == [], (
        "observed cases now exist — update this test to require them and prune the "
        "synthetic stand-ins they replace."
    )


# ---------------------------------------------------------------------------
# the measurement that decides whether cross-model should be the DEFAULT
# ---------------------------------------------------------------------------


def test_report_deterministic_coverage(capsys):
    rules = by_tier("rules")
    judgement_defects = tuple(c for c in by_tier("judgement") if c.unsupported)
    defects = defective()
    total = len(defects)
    caught = sum(1 for c in defects if _floor_catches(c)[0])
    residual = len(judgement_defects)

    with capsys.disabled():
        print("\n  ── research grounding: what deterministic code already decides ──")
        print(f"  defect corpus size ......... {total}")
        print(f"  caught by the floor ........ {caught}/{total} ({100 * caught // total}%)")
        print(f"  rules tier (code decides) .. {len(rules)}")
        print(f"  judgement residual ......... {residual} "
              f"({100 * residual // total}% of the defect corpus)")
        print("  → a second model can only affect the residual. Cost/benefit for making")
        print("    cross-model the DEFAULT must be argued against that slice, not the whole.")
        print("  → provenance: corpus is SYNTHETIC; P1's ledger signal now enables")
        print("    replacing these with defects observed in real runs.")

    assert caught == len(rules), "the floor must decide every rules-tier case and no other"
