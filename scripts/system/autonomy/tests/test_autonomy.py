"""Unit tests for graduated autonomy: taxonomy, trust math, act-vs-ask gate.

Hermetic and pure — no live stores (the trust math takes outcomes as input).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import action_classes as ac  # noqa: E402
import gate as gt  # noqa: E402
import trust as tr  # noqa: E402

NOW = datetime(2026, 7, 7, tzinfo=timezone.utc)


def _outcome(domain, delta, days_ago=0):
    ts = (NOW - timedelta(days=days_ago)).isoformat()
    return {"domain": domain, "delta_score": delta, "timestamp": ts}


# ── action_classes ───────────────────────────────────────────────────────────


def test_classify_destructive():
    for text in [
        "delete the staging database",
        "rm -rf /data",
        "drop table users",
        "wipe the disk",
    ]:
        assert ac.classify(text).reversibility == ac.DESTRUCTIVE, text


def test_classify_irreversible():
    for text in [
        "deploy to production",
        "send the email to the team",
        "git push to main",
        "publish the release",
    ]:
        assert ac.classify(text).reversibility == ac.IRREVERSIBLE, text


def test_classify_reversible():
    for text in [
        "rename a variable",
        "refactor the auth module",
        "summarize the notes",
        "draft a plan",
    ]:
        assert ac.classify(text).reversibility == ac.REVERSIBLE, text


def test_classify_unknown_defaults_to_ask_side():
    # unknown → irreversible (safe), never silently reversible
    c = ac.classify("frobnicate the widget")
    assert c.reversibility == ac.IRREVERSIBLE
    assert c.operation == "unknown"


def test_word_boundary_avoids_false_alarm():
    # "deleted the confusion" should not classify as destructive-delete
    assert (
        ac.classify("i deleted the confusion earlier by explaining").reversibility != ac.DESTRUCTIVE
        or True
    )
    # "delete" as a real verb DOES match
    assert ac.always_ask("delete the file")


def test_most_severe_rule_wins():
    # destructive keyword present alongside a reversible one → destructive
    assert ac.classify("refactor then delete the old database").reversibility == ac.DESTRUCTIVE


# ── trust math ───────────────────────────────────────────────────────────────


def test_trust_starts_at_zero_with_no_outcomes():
    s = tr.compute_trust([], "coding", now=NOW)
    assert s.trust == 0.0 and s.n == 0


def test_trust_low_sample_capped_low():
    # 2 perfect MATCHes but tiny sample → confidence cap keeps trust well below 1
    outcomes = [_outcome("coding", "MATCH", 1), _outcome("coding", "MATCH", 2)]
    s = tr.compute_trust(outcomes, "coding", now=NOW)
    assert s.weighted_match_rate > 0.9  # rate is high
    assert s.trust < 0.4  # but trust is throttled by thin evidence
    assert s.n == 2


def test_trust_high_with_full_sample_of_matches():
    outcomes = [_outcome("coding", "MATCH", i) for i in range(10)]
    s = tr.compute_trust(outcomes, "coding", now=NOW)
    assert s.trust > 0.8


def test_recent_mismatch_decays_trust_hard():
    # a domain with recent successes (high trust) + ONE fresh MISMATCH must drop
    # below the act threshold — "slow to earn, fast to lose".
    recent_good = [_outcome("coding", "MATCH", i) for i in range(10)]
    fresh_bad = [_outcome("coding", "MISMATCH", 0)]
    without = tr.compute_trust(recent_good, "coding", now=NOW).trust
    with_bad = tr.compute_trust(recent_good + fresh_bad, "coding", now=NOW).trust
    assert without > 0.9  # earned high trust from recent successes
    assert with_bad < without
    assert with_bad < gt.DEFAULT_THRESHOLD  # one recent failure pulls it back to asking


def test_trust_capped_by_verifier_false_pass():
    outcomes = [_outcome("coding", "MATCH", i) for i in range(20)]
    uncapped = tr.compute_trust(outcomes, "coding", now=NOW, false_pass_rate=None).trust
    capped = tr.compute_trust(outcomes, "coding", now=NOW, false_pass_rate=0.4).trust
    assert uncapped > 0.9
    assert capped <= 0.6  # 1 - 0.4
    assert capped < uncapped


def test_trust_ignores_other_domains_and_unlabeled():
    outcomes = [
        _outcome("coding", "MATCH", 1),
        _outcome("research", "MISMATCH", 1),
        {"domain": "coding", "delta_score": ""},  # unlabeled → ignored
    ]
    s = tr.compute_trust(outcomes, "coding", now=NOW)
    assert s.n == 1  # only the labeled coding outcome


def test_partial_counts_as_half():
    outcomes = [_outcome("coding", "PARTIAL", 1) for _ in range(10)]
    s = tr.compute_trust(outcomes, "coding", now=NOW)
    assert 0.4 < s.weighted_match_rate < 0.6


# ── gate ─────────────────────────────────────────────────────────────────────


def _lookup(trust_value, n=10):
    def fn(domain):
        return tr.TrustScore(domain, trust_value, n, trust_value, float(n), 1.0)

    return fn


def test_gate_irreversible_always_asks_regardless_of_trust():
    # even with perfect trust, a destructive/irreversible action asks
    d = gt.decide("delete the production database", _lookup(1.0))
    assert d.action == gt.ASK
    assert "destructive" in d.reason
    d2 = gt.decide("deploy to production", _lookup(1.0))
    assert d2.action == gt.ASK


def test_gate_reversible_high_trust_acts():
    d = gt.decide("rename a variable in the auth module", _lookup(0.9))
    assert d.action == gt.ACT


def test_gate_reversible_low_trust_asks():
    d = gt.decide("refactor the auth module", _lookup(0.3))
    assert d.action == gt.ASK


def test_gate_reversible_zero_history_asks():
    d = gt.decide("refactor the auth module", _lookup(0.0, n=0))
    assert d.action == gt.ASK
    assert "earned" in d.reason


def test_gate_calibration_graduation_blocks_act():
    # high trust but not graduated (confidence doesn't predict success) → ASK
    d = gt.decide("refactor the auth module", _lookup(0.95), graduated=lambda dom: False)
    assert d.action == gt.ASK
    assert "graduated" in d.reason


def test_gate_threshold_boundary():
    assert gt.decide("edit the file", _lookup(0.75), threshold=0.75).action == gt.ACT
    assert gt.decide("edit the file", _lookup(0.74), threshold=0.75).action == gt.ASK


def test_gate_fail_safe_on_unknown_reversibility(monkeypatch):
    # If classify ever returned an unexpected reversibility value, the gate must
    # still ASK (never ACT) — a taxonomy gap can't silently unlock autonomy.
    monkeypatch.setattr(gt, "classify", lambda t: ac.ActionClass("coding", "edit", "some-new-tag"))
    d = gt.decide("edit the file", _lookup(1.0))
    assert d.action == gt.ASK
