# compression_loop tests — TDD
"""Main self-improvement loop: outcomes → patterns → amendments."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compression_loop import identify_patterns, run_compression_loop  # noqa: E402


class TestIdentifyPatterns:
    """Pattern detection from outcome/diary evidence."""

    def test_single_mismatch_no_pattern(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong assumption",
            }
        ]
        patterns = identify_patterns(outcomes)
        assert patterns == []

    def test_repeated_domain_pattern_detected(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
            },
            {
                "decision_id": "d3",
                "outcome": "PARTIAL",
                "domain": "coding",
                "reason": "wrong package manager",
            },
        ]
        patterns = identify_patterns(outcomes)
        assert len(patterns) == 1
        assert "package manager" in patterns[0].lower()

    def test_multiple_separate_patterns(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "wrong package manager",
            },
            {
                "decision_id": "d3",
                "outcome": "MISMATCH",
                "domain": "planning",
                "reason": "missed dependencies",
            },
            {
                "decision_id": "d4",
                "outcome": "MISMATCH",
                "domain": "planning",
                "reason": "missed dependencies",
            },
        ]
        patterns = identify_patterns(outcomes)
        assert len(patterns) == 2
        assert any("package manager" in p.lower() for p in patterns)
        assert any("dependencies" in p.lower() for p in patterns)

    def test_ignores_match_outcomes(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MATCH",
                "domain": "coding",
                "reason": "everything fine",
            },
            {
                "decision_id": "d2",
                "outcome": "MATCH",
                "domain": "coding",
                "reason": "everything fine",
            },
        ]
        patterns = identify_patterns(outcomes)
        assert patterns == []

    def test_ignores_single_occurrence(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "unique issue",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "other unique issue",
            },
        ]
        patterns = identify_patterns(outcomes)
        assert patterns == []


class TestRunCompressionLoop:
    """End-to-end loop with mocked dependencies."""

    def test_no_patterns_returns_empty(self):
        outcomes = [
            {"decision_id": "d1", "outcome": "MATCH", "domain": "coding", "reason": "ok"},
        ]
        result = run_compression_loop(outcomes)
        assert result == []

    def test_patterns_generate_amendments(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "assumed uv without checking",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "assumed uv without checking",
            },
            {
                "decision_id": "d3",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "assumed uv without checking",
            },
        ]
        result = run_compression_loop(outcomes)
        assert len(result) >= 1
        amendment = result[0]
        assert amendment["status"] in ("PENDING", "INVALID")
        assert "amendment_id" in amendment
        assert amendment["target_layer"] == "DOMAIN_GUIDANCE"

    def test_universal_learnings_get_rejected(self):
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "universal",
                "reason": "should add before responding step",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "universal",
                "reason": "should add before responding step",
            },
        ]
        result = run_compression_loop(outcomes)
        assert len(result) >= 1
        assert result[0]["target_layer"] == "REJECTED_UNIVERSAL"

    def test_dedup_prevents_duplicate_amendments(self):
        """Same pattern proposed twice should deduplicate."""
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "same issue",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "same issue",
            },
        ]
        result1 = run_compression_loop(outcomes)
        # Same data fed again → dedup against previous
        result2 = run_compression_loop(outcomes, previous_amendments=result1)
        assert len(result2) == 0  # deduplicated
