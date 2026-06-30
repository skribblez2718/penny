import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest  # noqa: E402
from outcome_ledger.schema import OutcomeRecord, generate_decision_id  # noqa: E402


class TestOutcomeRecord:
    """Schema validation and dataclass behaviour."""

    def test_complete_record(self):
        rec = OutcomeRecord(
            decision_id="decision_2026-04-12_001",
            session_id="sess-001",
            action_taken="Refactored auth module",
            expected_outcome="Tests still pass",
            actual_outcome="One test failed",
            delta_score="PARTIAL",
            confidence_at_action="PROBABLE",
            domain="coding",
            user_feedback="Approved with note",
        )
        assert rec.decision_id == "decision_2026-04-12_001"
        assert rec.is_evaluated() is True
        assert rec.is_consequential() is False  # PROBABLE is above threshold

    def test_pending_record_is_not_evaluated(self):
        rec = OutcomeRecord(
            decision_id="d1",
            session_id="s1",
            action_taken="Did thing",
            expected_outcome="It works",
            confidence_at_action="POSSIBLE",
        )
        assert rec.is_evaluated() is False
        assert rec.is_consequential() is True  # POSSIBLE triggers threshold

    def test_uncertain_is_consequential(self):
        rec = OutcomeRecord(
            decision_id="d1",
            session_id="s1",
            action_taken="Did thing",
            expected_outcome="It works",
            confidence_at_action="UNCERTAIN",
        )
        assert rec.is_consequential() is True

    def test_serialization_roundtrip(self):
        rec = OutcomeRecord(
            decision_id="d1",
            session_id="s1",
            action_taken="Action",
            expected_outcome="Expected",
            actual_outcome="Actual",
            delta_score="MATCH",
            confidence_at_action="CERTAIN",
            domain="planning",
            user_feedback="All good",
        )
        raw = rec.to_json()
        restored = OutcomeRecord.from_json(raw)
        assert restored.decision_id == rec.decision_id
        assert restored.delta_score == rec.delta_score
        assert restored.user_feedback == rec.user_feedback

    def test_validation_missing_decision_id(self):
        rec = OutcomeRecord(
            decision_id="",
            session_id="s1",
            action_taken="Action",
            expected_outcome="Expected",
        )
        with pytest.raises(ValueError, match="decision_id"):
            rec.validate()

    def test_validation_invalid_delta_score(self):
        rec = OutcomeRecord(
            decision_id="d1",
            session_id="s1",
            action_taken="Action",
            expected_outcome="Expected",
            delta_score="GREAT",  # invalid
        )
        with pytest.raises(ValueError, match="delta_score"):
            rec.validate()

    def test_validation_invalid_confidence(self):
        rec = OutcomeRecord(
            decision_id="d1",
            session_id="s1",
            action_taken="Action",
            expected_outcome="Expected",
            confidence_at_action="MAYBE",  # invalid
        )
        with pytest.raises(ValueError, match="confidence_at_action"):
            rec.validate()

    def test_default_timestamp_iso8601(self):
        rec = OutcomeRecord(
            decision_id="d1",
            session_id="s1",
            action_taken="A",
            expected_outcome="E",
        )
        assert rec.timestamp.startswith("20")
        assert "T" in rec.timestamp or "+" in rec.timestamp


class TestGenerateDecisionId:
    def test_format(self):
        did = generate_decision_id("sess-001", 5)
        assert did.startswith("decision_")
        assert "sess-001" not in did  # session_id not part of id
        assert "005" in did  # seq zero-padded
