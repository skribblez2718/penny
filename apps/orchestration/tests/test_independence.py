"""Verification-independence checks for the retained research edge."""

from __future__ import annotations

import datetime as dt

from orchestration import independence as ind


def test_invariant_holds_no_unregistered_same_model_edges():
    assert ind.check_independence() == []


def test_no_stale_exceptions():
    assert ind.stale_exceptions() == []


def test_every_referenced_agent_resolves_to_a_model():
    assert ind.VERIFY_EDGES == (ind.VerifyEdge("research", "synthia", "vera", ""),)
    for edge in ind.VERIFY_EDGES:
        for agent in (edge.actor, edge.verifier):
            assert ind.agent_model(agent) == "terra"


def test_agent_model_reads_frontmatter_live():
    assert ind.agent_model("synthia") == "terra"
    assert ind.agent_model("vera") == "terra"


def test_agent_model_is_fail_loud_on_unknown_agent():
    try:
        ind.agent_model("does_not_exist")
    except (FileNotFoundError, ValueError):
        return
    raise AssertionError("agent_model must raise on an unresolvable agent")


def test_research_edge_is_same_model_and_registered():
    edge = ind.VERIFY_EDGES[0]
    assert ind.classify(edge) == ind.SAME_MODEL
    assert set(ind.SAME_MODEL_EXCEPTIONS) == {"research"}


def test_exception_is_live_dated_and_rationalized():
    edge = ind.VERIFY_EDGES[0]
    exception = ind.SAME_MODEL_EXCEPTIONS["research"]
    assert exception.skill == edge.skill
    assert len(exception.rationale) > 40
    dt.date.fromisoformat(exception.review_by)


def test_fail_loud_a_new_unregistered_same_model_edge_is_flagged(monkeypatch):
    rogue = ind.VerifyEdge("rogue_skill", "synthia", "vera", "")
    monkeypatch.setattr(ind, "VERIFY_EDGES", ind.VERIFY_EDGES + (rogue,))
    assert "rogue_skill" in ind.check_independence()


def test_registering_the_rogue_edge_clears_the_violation(monkeypatch):
    rogue = ind.VerifyEdge("rogue_skill", "synthia", "vera", "")
    exception = ind.IndependenceException("rogue_skill", "x" * 41, "2026-10-01")
    monkeypatch.setattr(ind, "VERIFY_EDGES", ind.VERIFY_EDGES + (rogue,))
    monkeypatch.setattr(
        ind,
        "SAME_MODEL_EXCEPTIONS",
        {**ind.SAME_MODEL_EXCEPTIONS, "rogue_skill": exception},
    )
    assert ind.check_independence() == []


def test_naming_an_independent_check_also_clears_the_violation(monkeypatch):
    fixed = ind.VerifyEdge("rogue_skill", "synthia", "vera", "deterministic schema oracle")
    monkeypatch.setattr(ind, "VERIFY_EDGES", ind.VERIFY_EDGES + (fixed,))
    assert "rogue_skill" not in ind.check_independence()
    assert ind.classify(fixed) == ind.INDEPENDENT_CHECK
