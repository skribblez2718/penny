"""The model-roster event trigger: expiry driven by FLEET CHANGE, not by a calendar.

Both ledgers of borrowed scaffolding — ``loans.py`` (mechanisms compensating for model
weakness) and ``independence.py`` (accepted same-model verify edges) — carried only a
hand-typed ``review_by`` date. A date fires when the earth has moved, not when the
models have, which is precisely backwards: the doctrine says re-audit *"event-driven on
a major model upgrade — a stronger model is precisely when scaffolding becomes newly
obsolete"*.

These tests hold the trigger to the only standard that matters for a tripwire: it must
actually TRIP. A checker that always returns "nothing to review" is worse than none,
because it looks like assurance.
"""

from __future__ import annotations

import pytest

from orchestration import independence as ind
from orchestration import loans as loans_mod
from orchestration import roster as roster_mod
from orchestration.roster import (
    distinct_models,
    model_roster,
    roster_changed,
    roster_hash,
)


def _agents(tmp_path, mapping: dict) -> str:
    d = tmp_path / "agents"
    d.mkdir(parents=True, exist_ok=True)
    for name, model in mapping.items():
        (d / f"{name}.md").write_text(
            f"---\nname: {name}\nmodel: {model}\nprovider: anthropic\n---\nbody\n",
            encoding="utf-8",
        )
    return str(d)


# ---------------------------------------------------------------------------
# reading the fleet
# ---------------------------------------------------------------------------


def test_roster_reads_models_from_frontmatter(tmp_path):
    d = _agents(tmp_path, {"vera": "sonnet", "echo": "opus"})
    assert model_roster(d) == {"echo": "opus", "vera": "sonnet"}
    assert distinct_models(d) == ("opus", "sonnet")


def test_agent_without_a_model_is_omitted_not_guessed(tmp_path):
    d = _agents(tmp_path, {"vera": "sonnet"})
    (tmp_path / "agents" / "broken.md").write_text("---\nname: broken\n---\n", encoding="utf-8")
    assert "broken" not in model_roster(d)


def test_hash_is_stable_and_order_independent(tmp_path):
    a = _agents(tmp_path / "a", {"x": "opus", "y": "sonnet"})
    b = _agents(tmp_path / "b", {"y": "sonnet", "x": "opus"})
    assert roster_hash(a) == roster_hash(b)


def test_repointing_an_agent_within_the_same_fleet_does_not_move_the_hash(tmp_path):
    """Deliberate: re-pointing one agent at a model already in the fleet is caught
    LIVE and more precisely by independence.classify. This trigger is for the fleet
    gaining/losing/swapping a MODEL."""
    before = _agents(tmp_path / "before", {"a": "opus", "b": "sonnet"})
    after = _agents(tmp_path / "after", {"a": "sonnet", "b": "opus"})
    assert roster_hash(before) == roster_hash(after)


def test_a_new_model_in_the_fleet_moves_the_hash(tmp_path):
    before = _agents(tmp_path / "before", {"a": "opus", "b": "sonnet"})
    after = _agents(tmp_path / "after", {"a": "opus", "b": "sonnet", "c": "opus-5"})
    assert roster_hash(before) != roster_hash(after)


def test_swapping_the_fleet_wholesale_moves_the_hash(tmp_path):
    before = _agents(tmp_path / "before", {"a": "opus", "b": "sonnet"})
    after = _agents(tmp_path / "after", {"a": "opus-5", "b": "sonnet-5"})
    assert roster_hash(before) != roster_hash(after)


def test_missing_agents_dir_reads_as_unknown_not_as_a_change(tmp_path):
    """An unreadable fleet must mean 'cannot tell', never 'everything changed' \u2014\n    otherwise a path problem would spam every acceptance as needing review."""
    assert roster_hash(str(tmp_path / "nope")) == ""
    assert roster_changed("0504ae3f4c3e", str(tmp_path / "nope")) is False


def test_unbaselined_entry_is_not_reported_as_changed(tmp_path):
    d = _agents(tmp_path, {"a": "opus"})
    assert roster_changed("", d) is False


# ---------------------------------------------------------------------------
# the tripwire must TRIP \u2014 on both ledgers
# ---------------------------------------------------------------------------


def test_fleet_unchanged_means_nothing_needs_review():
    assert loans_mod.loans_needing_review() == []
    assert ind.exceptions_needing_roster_review() == []


def test_a_loan_recorded_against_another_fleet_is_flagged():
    stale = loans_mod.Loan(
        loan_id="x",
        description="d",
        rationale="r",
        added="2026-01-01",
        review_by="2099-01-01",  # calendar says fine...
        roster_at_review="ffffffffffff",  # ...but the fleet moved
    )
    assert stale.fleet_changed is True, (
        "a loan taken against a different fleet must be flagged even when its "
        "review_by date is far in the future \u2014 that is the whole point"
    )


def test_loans_needing_review_lists_the_moved_ones(monkeypatch):
    moved = loans_mod.Loan("moved", "d", "r", "2026-01-01", "2099-01-01", "ffffffffffff")
    kept = loans_mod.Loan("kept", "d", "r", "2026-01-01", "2099-01-01", loans_mod.current_roster())
    monkeypatch.setattr(loans_mod, "LOANS", {"moved": moved, "kept": kept})
    assert [loan.loan_id for loan in loans_mod.loans_needing_review()] == ["moved"]


def test_an_exception_recorded_against_another_fleet_is_flagged(monkeypatch):
    exc = ind.IndependenceException("research", "x" * 41, "2099-01-01", "ffffffffffff")
    monkeypatch.setattr(ind, "SAME_MODEL_EXCEPTIONS", {"research": exc})
    assert ind.exceptions_needing_roster_review() == ["research"]


def test_roster_review_is_a_distinct_signal_from_staleness(monkeypatch):
    """`stale_exceptions` catches an edge that stopped being same-model (debt repaid).\n    Roster review catches the fleet changing under an acceptance that is still\n    same-model. Conflating them would hide one behind the other."""
    exc = ind.IndependenceException("research", "x" * 41, "2099-01-01", "ffffffffffff")
    monkeypatch.setattr(ind, "SAME_MODEL_EXCEPTIONS", {"research": exc})
    assert ind.exceptions_needing_roster_review() == ["research"]
    assert ind.stale_exceptions() == []  # still a genuine same-model edge


def test_current_roster_is_what_a_reviewer_records():
    assert loans_mod.current_roster() == roster_hash()
    assert ind.current_roster() == roster_hash()
    assert roster_hash() != ""


def test_every_registered_loan_is_baselined():
    """An un-baselined loan silently opts out of the event trigger."""
    unbaselined = [loan.loan_id for loan in loans_mod.list_loans() if not loan.roster_at_review]
    assert unbaselined == [], f"loans with no roster baseline: {unbaselined}"


def test_every_registered_exception_is_baselined():
    unbaselined = [
        skill for skill, exc in ind.SAME_MODEL_EXCEPTIONS.items() if not exc.roster_at_review
    ]
    assert unbaselined == [], f"exceptions with no roster baseline: {unbaselined}"


def test_recorded_baseline_matches_the_live_fleet():
    """The committed BASELINE_ROSTER constants must describe the fleet actually on
    disk. If this fails, the fleet changed and every acceptance is due for review \u2014
    re-measure, then update the constant. Do NOT just re-type the new hash.\"\"\"
    """
    live = roster_hash()
    assert loans_mod.BASELINE_ROSTER == live, (
        f"loans BASELINE_ROSTER={loans_mod.BASELINE_ROSTER} but the live fleet is {live} "
        f"({', '.join(distinct_models())}). The fleet changed: re-ablate the loans, then "
        f"record the new roster."
    )
    assert ind.BASELINE_ROSTER == live, (
        f"independence BASELINE_ROSTER={ind.BASELINE_ROSTER} but the live fleet is {live}. "
        f"The fleet changed: re-measure the same-model exceptions, then record it."
    )
