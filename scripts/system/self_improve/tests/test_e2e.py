# E2E tests — self-improvement full flow
"""End-to-end: outcomes → compression → amendments → review → apply/ reject."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compression_loop import run_compression_loop  # noqa: E402
from amendment_applier import apply_amendment  # noqa: E402


class TestFullSelfImprovementFlow:
    """Complete lifecycle from outcomes to applied or rejected amendments."""

    def test_single_domain_pattern_produces_amendment_ready_for_review(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
                "session_id": "s1",
                "confidence_at_action": "POSSIBLE",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
                "session_id": "s2",
                "confidence_at_action": "POSSIBLE",
            },
        ]
        amendments = run_compression_loop(outcomes)

        assert len(amendments) == 1
        a = amendments[0]
        assert a["status"] == "PENDING"
        assert a["target_layer"] == "DOMAIN_GUIDANCE"
        assert len(a["changes"]) == 1
        assert len(a["evidence"]) == 2
        # Applier rejects until user approves
        result = apply_amendment(a, git_commit=False)
        assert result["success"] is False
        assert "not approved" in result["error"]

    def test_universal_learning_blocked_at_every_stage(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "universal",
                "reason": "Add new confidence level",
                "session_id": "s1",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "universal",
                "reason": "Add new confidence level",
                "session_id": "s2",
            },
        ]
        amendments = run_compression_loop(outcomes)

        assert len(amendments) == 1
        a = amendments[0]
        assert a["target_layer"] == "REJECTED_UNIVERSAL"

        # Even forcing APPROVED fails at applier
        a["status"] = "APPROVED"
        result = apply_amendment(a, git_commit=False)
        assert result["success"] is False
        assert "REJECTED_UNIVERSAL" in result["error"]

    def test_dedup_prevents_duplicate_proposals(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "same issue",
                "session_id": "s1",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "same issue",
                "session_id": "s2",
            },
        ]
        result1 = run_compression_loop(outcomes)
        assert len(result1) == 1

        # Second run deduplicates
        result2 = run_compression_loop(outcomes, previous_amendments=result1)
        assert len(result2) == 0

    def test_multiple_patterns_produce_multiple_amendments(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
                "session_id": "s1",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
                "session_id": "s1",
            },
            {
                "decision_id": "d3",
                "outcome": "MISMATCH",
                "domain": "planning",
                "reason": "missed dependencies",
                "session_id": "s2",
            },
            {
                "decision_id": "d4",
                "outcome": "MISMATCH",
                "domain": "planning",
                "reason": "missed dependencies",
                "session_id": "s2",
            },
        ]
        amendments = run_compression_loop(outcomes)
        assert len(amendments) == 2
        targets = {a["target_layer"] for a in amendments}
        assert "DOMAIN_GUIDANCE" in targets

    def test_empty_outcomes_produce_no_amendments(self):
        outcomes = []
        amendments = run_compression_loop(outcomes)
        assert amendments == []

    def test_match_only_outcomes_produce_no_amendments(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MATCH",
                "domain": "coding",
                "reason": "ok",
                "session_id": "s1",
            },
            {
                "decision_id": "d2",
                "outcome": "MATCH",
                "domain": "coding",
                "reason": "ok",
                "session_id": "s2",
            },
        ]
        amendments = run_compression_loop(outcomes)
        assert amendments == []
