# digest generator tests — TDD
"""Aggregate mempalace data into structured digest JSON."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from generator import (  # noqa: E402
    aggregate_outcomes,
    aggregate_confidence,
    identify_attention_flags,
    build_digest_json,
)


class TestAggregateOutcomes:
    """Tally MATCH/PARTIAL/MISMATCH from outcome records."""

    def test_basic_tally(self):
        outcomes = [
            {"outcome": "MATCH", "domain": "coding", "reason": "ok"},
            {"outcome": "MATCH", "domain": "coding", "reason": "ok"},
            {"outcome": "PARTIAL", "domain": "planning", "reason": "missed edge case"},
            {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong file"},
        ]
        result = aggregate_outcomes(outcomes)
        assert result["MATCH"] == 2
        assert result["PARTIAL"] == 1
        assert result["MISMATCH"] == 1
        assert result["unevaluated"] == 0

    def test_empty_outcomes(self):
        result = aggregate_outcomes([])
        assert result == {"MATCH": 0, "PARTIAL": 0, "MISMATCH": 0, "unevaluated": 0}

    def test_missing_outcome_field(self):
        outcomes = [
            {"outcome": "MATCH"},
            {"domain": "coding"},  # missing outcome
        ]
        result = aggregate_outcomes(outcomes)
        assert result["MATCH"] == 1
        assert result["unevaluated"] == 1

    def test_domain_breakdown(self):
        outcomes = [
            {"outcome": "MATCH", "domain": "coding"},
            {"outcome": "MISMATCH", "domain": "coding"},
            {"outcome": "MATCH", "domain": "planning"},
        ]
        result = aggregate_outcomes(outcomes, include_domains=True)
        assert "domains" in result
        assert result["domains"]["coding"]["total"] == 2
        assert result["domains"]["coding"]["MISMATCH"] == 1
        assert result["domains"]["planning"]["total"] == 1


class TestAggregateConfidence:
    """Tally confidence levels from outcome records."""

    def test_basic_confidence_tally(self):
        outcomes = [
            {"confidence_at_action": "CERTAIN"},
            {"confidence_at_action": "CERTAIN"},
            {"confidence_at_action": "PROBABLE"},
            {"confidence_at_action": "POSSIBLE"},
            {"confidence_at_action": "UNCERTAIN"},
        ]
        result = aggregate_confidence(outcomes)
        assert result["CERTAIN"] == 2
        assert result["PROBABLE"] == 1
        assert result["POSSIBLE"] == 1
        assert result["UNCERTAIN"] == 1

    def test_missing_confidence(self):
        outcomes = [
            {"confidence_at_action": "CERTAIN"},
            {"outcome": "MATCH"},  # missing confidence
        ]
        result = aggregate_confidence(outcomes)
        assert result["CERTAIN"] == 1


class TestIdentifyAttentionFlags:
    """Flag patterns requiring user attention."""

    def test_mismatch_pattern_flagged(self):
        outcomes = [
            {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong file", "session_id": "s1", "decision_id": "d1"},
            {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong path", "session_id": "s1", "decision_id": "d2"},
        ]
        flags = identify_attention_flags(outcomes)
        assert len(flags) == 1
        assert flags[0]["type"] == "MISMATCH"
        assert flags[0]["severity"] == "HIGH"
        assert "coding" in flags[0]["description"]

    def test_single_mismatch_not_flagged(self):
        outcomes = [
            {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong file", "session_id": "s1", "decision_id": "d1"},
        ]
        flags = identify_attention_flags(outcomes)
        assert len(flags) == 0  # single occurrence not a pattern

    def test_critical_signals_flagged(self):
        signals = [
            {"signal_type": "METRIC", "priority": "CRITICAL", "title": "High mismatch rate", "session_id": "s1"},
        ]
        outcomes = []
        flags = identify_attention_flags(outcomes, signals=signals)
        assert len(flags) == 1
        assert flags[0]["type"] == "CRITICAL_SIGNAL"
        assert "High mismatch rate" in flags[0]["description"]

    def test_no_flags(self):
        outcomes = [
            {"outcome": "MATCH", "domain": "coding"},
        ]
        flags = identify_attention_flags(outcomes)
        assert flags == []


class TestBuildDigestJson:
    """End-to-end digest JSON construction."""

    def test_basic_digest_structure(self):
        outcomes = [
            {"outcome": "MATCH", "domain": "coding", "confidence_at_action": "PROBABLE", "session_id": "s1"},
            {"outcome": "MATCH", "domain": "coding", "confidence_at_action": "CERTAIN", "session_id": "s1"},
        ]
        diary = []
        digest = build_digest_json(outcomes, diary, "2026-04-21", "2026-04-28")
        assert "digest_id" in digest
        assert digest["week_start"] == "2026-04-21"
        assert digest["week_end"] == "2026-04-28"
        assert "session_ids" in digest
        assert "s1" in digest["session_ids"]
        assert digest["outcomes"]["MATCH"] == 2

    def test_session_ids_deduplicated(self):
        outcomes = [
            {"outcome": "MATCH", "session_id": "s1"},
            {"outcome": "PARTIAL", "session_id": "s1"},
            {"outcome": "MISMATCH", "session_id": "s2"},
        ]
        digest = build_digest_json(outcomes, [], "2026-04-21", "2026-04-28")
        assert sorted(digest["session_ids"]) == ["s1", "s2"]

    def test_recommendations_generated(self):
        outcomes = [
            {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong file", "session_id": "s1", "decision_id": "d1"},
            {"outcome": "MISMATCH", "domain": "coding", "reason": "wrong path", "session_id": "s1", "decision_id": "d2"},
        ]
        digest = build_digest_json(outcomes, [], "2026-04-21", "2026-04-28")
        assert len(digest["recommendations"]) > 0
        assert any("MISMATCH" in r for r in digest["recommendations"])

    def test_includes_amendments_and_signals(self):
        outcomes = []
        amendments = {"proposed": 2, "approved": 1, "rejected": 0, "pending": 1}
        signals = [
            {"signal_type": "METRIC", "priority": "CRITICAL", "title": "High mismatch", "status": "PENDING"},
            {"signal_type": "METRIC", "priority": "INFO", "title": "Normal", "status": "PENDING"},
        ]
        digest = build_digest_json(outcomes, [], "2026-04-21", "2026-04-28", amendments=amendments, signals=signals)
        assert digest["amendments_summary"]["proposed"] == 2
        assert digest["amendments_summary"]["approved"] == 1
        assert digest["signals_summary"]["critical_pending"] == 1

    def test_empty_week(self):
        digest = build_digest_json([], [], "2026-04-21", "2026-04-28")
        assert digest["summary"]["sessions"] == 0
        assert digest["summary"]["decisions"] == 0
        assert digest["attention_flags"] == []
        assert digest["recommendations"] == []
