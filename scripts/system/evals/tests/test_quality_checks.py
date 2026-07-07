"""Unit tests for the amendment-efficacy eval math (live stores monkeypatched)."""

import json
from datetime import datetime, timedelta, timezone

import eval_quality
from eval_lib import SKIP

APPLIED_AT = datetime(2026, 6, 1, tzinfo=timezone.utc)


def _amendment_drawer(status="APPLIED", domain="coding", applied_date=None):
    record = {
        "amendment_id": "amend_x",
        "status": status,
        "domain": domain,
        "applied_date": (applied_date or APPLIED_AT).isoformat(),
    }
    return {
        "id": "drawer_penny_system_amendments_x",
        "content": "amendment_id: amend_x\n" + json.dumps(record),
    }


def _outcome(outcome, days_from_apply, domain="coding"):
    return {
        "outcome": outcome,
        "domain": domain,
        "_when": APPLIED_AT + timedelta(days=days_from_apply),
    }


class TestAmendmentEfficacy:
    def test_positive_delta_when_mismatches_drop(self, monkeypatch):
        monkeypatch.setattr(eval_quality, "load_room", lambda *a, **k: [_amendment_drawer()])
        outcomes = [_outcome("MISMATCH", -d) for d in (1, 5, 9)] + [  # before: 3/3 suboptimal
            _outcome("MATCH", d) for d in (1, 5, 9)
        ]  # after: 0/3 suboptimal
        monkeypatch.setattr(eval_quality, "load_outcomes", lambda *a, **k: outcomes)
        result = eval_quality.check_amendment_efficacy()
        assert result.value == 1.0  # rate dropped 1.0 -> 0.0
        assert result.direction == "up_good"

    def test_other_domain_outcomes_excluded(self, monkeypatch):
        monkeypatch.setattr(
            eval_quality, "load_room", lambda *a, **k: [_amendment_drawer(domain="coding")]
        )
        outcomes = (
            [_outcome("MISMATCH", -d) for d in (1, 5, 9)]
            + [_outcome("MATCH", d) for d in (1, 5, 9)]
            + [_outcome("MISMATCH", d, domain="research") for d in (2, 6, 10)]
        )
        monkeypatch.setattr(eval_quality, "load_outcomes", lambda *a, **k: outcomes)
        result = eval_quality.check_amendment_efficacy()
        assert result.value == 1.0  # research mismatches must not pollute coding delta

    def test_domainless_amendment_not_measured_against_all_outcomes(self, monkeypatch):
        """A domain-less amendment must be skipped, not credited with every
        global rate shift — a lucky window would ratchet the baseline to a
        value amendments can't reproduce."""
        drawer = _amendment_drawer()
        record = json.loads(drawer["content"].split("\n", 1)[1])
        del record["domain"]
        drawer["content"] = "amendment_id: amend_x\n" + json.dumps(record)
        monkeypatch.setattr(eval_quality, "load_room", lambda *a, **k: [drawer])
        outcomes = [_outcome("MISMATCH", -d) for d in (1, 5, 9)] + [
            _outcome("MATCH", d) for d in (1, 5, 9)
        ]
        monkeypatch.setattr(eval_quality, "load_outcomes", lambda *a, **k: outcomes)
        results = eval_quality.run_checks(
            [("quality.amendment_efficacy", eval_quality.check_amendment_efficacy)]
        )
        assert results[0].status == SKIP
        assert "without a domain" in results[0].detail

    def test_skips_without_applied_amendments(self, monkeypatch):
        monkeypatch.setattr(
            eval_quality, "load_room", lambda *a, **k: [_amendment_drawer(status="PENDING")]
        )
        monkeypatch.setattr(eval_quality, "load_outcomes", lambda *a, **k: [])
        results = eval_quality.run_checks(
            [("quality.amendment_efficacy", eval_quality.check_amendment_efficacy)]
        )
        assert results[0].status == SKIP
        assert "loop has not closed" in results[0].detail

    def test_skips_on_thin_windows(self, monkeypatch):
        monkeypatch.setattr(eval_quality, "load_room", lambda *a, **k: [_amendment_drawer()])
        monkeypatch.setattr(
            eval_quality,
            "load_outcomes",
            lambda *a, **k: [_outcome("MISMATCH", -1), _outcome("MATCH", 1)],
        )
        results = eval_quality.run_checks(
            [("quality.amendment_efficacy", eval_quality.check_amendment_efficacy)]
        )
        assert results[0].status == SKIP
        assert "thin windows" in results[0].detail

    def test_outcomes_outside_30d_windows_ignored(self, monkeypatch):
        monkeypatch.setattr(eval_quality, "load_room", lambda *a, **k: [_amendment_drawer()])
        outcomes = (
            [_outcome("MATCH", -d) for d in (1, 5, 9)]
            + [_outcome("MATCH", d) for d in (1, 5, 9)]
            + [_outcome("MISMATCH", 45), _outcome("MISMATCH", -45)]  # outside windows
        )
        monkeypatch.setattr(eval_quality, "load_outcomes", lambda *a, **k: outcomes)
        result = eval_quality.check_amendment_efficacy()
        assert result.value == 0.0  # clean both sides; distant mismatches ignored
