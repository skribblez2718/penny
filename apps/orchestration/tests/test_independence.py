"""The cross-model verification-independence invariant (T2).

Proves: (a) every skill's primary actor->verify edge is either cross-model, backed by a named
model-independent check, or a registered same-model exception; (b) a NEW same-model bare-judgement
edge cannot ship unregistered (fail-loud); (c) the exception ledger cannot rot (no stale entries,
every entry live, dated, and rationalised). Models are read LIVE from .pi/agents frontmatter.
"""

from __future__ import annotations

import datetime as dt

from orchestration import independence as ind


def test_invariant_holds_no_unregistered_same_model_edges():
    # The whole point: every SAME_MODEL bare-judgement edge is registered. Empty == invariant holds.
    assert ind.check_independence() == []


def test_no_stale_exceptions():
    # An exception whose edge is no longer SAME_MODEL (debt repaid / edge removed) must be pruned.
    assert ind.stale_exceptions() == []


def test_every_referenced_agent_resolves_to_a_model():
    for edge in ind.VERIFY_EDGES:
        for agent in (edge.actor, edge.verifier):
            assert ind.agent_model(agent) in {"opus", "sonnet"}, agent


def test_agent_model_reads_frontmatter_live():
    assert ind.agent_model("vera") == "sonnet"
    assert ind.agent_model("synthia") == "sonnet"
    assert ind.agent_model("skribble") == "opus"
    assert ind.agent_model("carren") == "opus"


def test_agent_model_is_fail_loud_on_unknown_agent():
    try:
        ind.agent_model("does_not_exist")
    except (FileNotFoundError, ValueError):
        return
    raise AssertionError("agent_model must raise on an unresolvable agent, never assume independence")


def test_classification_of_each_edge():
    got = {e.skill: ind.classify(e) for e in ind.VERIFY_EDGES}
    # The four the plan named + plan itself: same model, bare judgement.
    for skill in ("prd", "rez", "research", "plan"):
        assert got[skill] == ind.SAME_MODEL, skill
    # Evidence/oracle/second-critic backed -> independence without a model change.
    for skill in ("code", "jsa", "sca", "imagegen"):
        assert got[skill] == ind.INDEPENDENT_CHECK, skill
    # learn's verifier already runs a different model than its author.
    assert got["learn"] == ind.CROSS_MODEL


def test_plan_named_gaps_are_registered_exceptions():
    for skill in ("prd", "rez", "research", "plan"):
        assert skill in ind.SAME_MODEL_EXCEPTIONS, skill


def test_independent_check_edges_must_name_their_mechanism():
    # You cannot claim INDEPENDENT_CHECK without naming the model-independent signal.
    for edge in ind.VERIFY_EDGES:
        if ind.classify(edge) == ind.INDEPENDENT_CHECK:
            assert edge.independent_check.strip(), edge.skill


def test_cross_model_edges_really_differ_in_model():
    for edge in ind.VERIFY_EDGES:
        if ind.classify(edge) == ind.CROSS_MODEL:
            assert ind.agent_model(edge.actor) != ind.agent_model(edge.verifier), edge.skill


def test_each_exception_is_live_dated_and_rationalised():
    by_skill = {e.skill: e for e in ind.VERIFY_EDGES}
    for skill, exc in ind.SAME_MODEL_EXCEPTIONS.items():
        assert skill in by_skill, f"exception {skill} has no VERIFY_EDGE"
        assert ind.classify(by_skill[skill]) == ind.SAME_MODEL, f"{skill} exception is not same-model"
        assert len(exc.rationale) > 40, f"{skill} rationale too thin"
        # review_by is a real YYYY-MM-DD date.
        dt.date.fromisoformat(exc.review_by)


def test_fail_loud_a_new_unregistered_same_model_edge_is_flagged(monkeypatch):
    rogue = ind.VerifyEdge("rogue_skill", "synthia", "vera", "")  # sonnet->sonnet, no check, unregistered
    monkeypatch.setattr(ind, "VERIFY_EDGES", ind.VERIFY_EDGES + (rogue,))
    assert "rogue_skill" in ind.check_independence()


def test_registering_the_rogue_edge_clears_the_violation(monkeypatch):
    rogue = ind.VerifyEdge("rogue_skill", "synthia", "vera", "")
    exc = ind.IndependenceException("rogue_skill", "x" * 41, "2026-10-01")
    monkeypatch.setattr(ind, "VERIFY_EDGES", ind.VERIFY_EDGES + (rogue,))
    monkeypatch.setattr(ind, "SAME_MODEL_EXCEPTIONS", {**ind.SAME_MODEL_EXCEPTIONS, "rogue_skill": exc})
    assert ind.check_independence() == []


def test_naming_an_independent_check_also_clears_the_violation(monkeypatch):
    # The other repair path: same model, but a real model-independent check named -> not a violation.
    fixed = ind.VerifyEdge("rogue_skill", "synthia", "vera", "deterministic schema oracle")
    monkeypatch.setattr(ind, "VERIFY_EDGES", ind.VERIFY_EDGES + (fixed,))
    assert "rogue_skill" not in ind.check_independence()
    assert ind.classify(fixed) == ind.INDEPENDENT_CHECK
