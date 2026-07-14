# compression_loop tests — TDD
"""Main self-improvement loop: outcomes → patterns → amendments."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compression_loop import (  # noqa: E402
    cluster_outcomes,
    identify_patterns,
    run_compression_loop,
)


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

    def test_clusters_on_failure_mode_across_different_reasons(self):
        # THE KEYSTONE FIX: judge/human free-text reasons rarely repeat verbatim,
        # so reason-only clustering never fires. The categorical failure_mode
        # does recur — so a pattern is detected DESPITE the reasons differing.
        outcomes = [
            {
                "decision_id": "d1",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "assumed uv but the project uses pip",
                "failure_mode": "missing_constraint",
            },
            {
                "decision_id": "d2",
                "outcome": "MISMATCH",
                "domain": "coding",
                "reason": "ignored the pinned python version in the task",
                "failure_mode": "missing_constraint",
            },
        ]
        assert identify_patterns(outcomes) == ["missing_constraint"]

    def test_other_failure_mode_falls_back_to_reason(self):
        # "other" is the catch-all and must NOT cluster unrelated failures:
        # with different reasons it falls back to reason and finds no pattern.
        outcomes = [
            {"decision_id": "d1", "outcome": "MISMATCH", "reason": "weird A", "failure_mode": "other"},
            {"decision_id": "d2", "outcome": "MISMATCH", "reason": "weird B", "failure_mode": "other"},
        ]
        assert identify_patterns(outcomes) == []


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


# ── #20: semantic clustering (model-first, exact-string fallback) ─────────────


def _cluster_stream(payload_text: str) -> str:
    msg = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
           "content": [{"type": "text", "text": payload_text}]}}
    return json.dumps({"type": "agent_start"}) + "\n" + json.dumps(msg)


def _fake_runner(stdout="", *, returncode=0, raise_exc=None):
    class _Proc:
        pass

    def run(cmd, **kwargs):
        if raise_exc is not None:
            raise raise_exc
        p = _Proc()
        p.stdout, p.stderr, p.returncode = stdout, "", returncode
        return p

    return run


class TestSemanticClustering:
    """#20: cluster failures by MEANING (model), falling back to exact-string."""

    _FAILS = [
        {"decision_id": "d1", "outcome": "MISMATCH", "domain": "coding",
         "reason": "assumed uv but the project uses pip", "failure_mode": "wrong_pkg_mgr"},
        {"decision_id": "d2", "outcome": "MISMATCH", "domain": "coding",
         "reason": "forgot to run the linter before finishing", "failure_mode": "skipped_lint"},
        {"decision_id": "d3", "outcome": "MISMATCH", "domain": "coding",
         "reason": "used the wrong package manager again", "failure_mode": "pkg_mismatch"},
    ]

    def test_fallback_exact_string_when_gate_off(self, monkeypatch):
        monkeypatch.delenv("PI_SELFIMPROVE_CLUSTER_MODEL", raising=False)
        # open-vocab tags + reasons all differ -> exact-string finds no cluster >=2
        assert cluster_outcomes(self._FAILS) == []

    def test_model_groups_semantically(self, monkeypatch):
        monkeypatch.setenv("PI_SELFIMPROVE_CLUSTER_MODEL", "anthropic/haiku")
        # d1 & d3 share a root cause (wrong toolchain); the model groups them,
        # while the lone lint failure stays a single-member cluster (dropped).
        payload = json.dumps({"clusters": [
            {"label": "wrong toolchain assumption", "members": [0, 2]},
            {"label": "skipped_lint", "members": [1]},
        ]})
        clusters = cluster_outcomes(self._FAILS, runner=_fake_runner(_cluster_stream(payload)))
        assert len(clusters) == 1
        c = clusters[0]
        assert c["label"] == "wrong_toolchain_assumption"
        assert {m["decision_id"] for m in c["members"]} == {"d1", "d3"}

    def test_model_failure_falls_back_to_exact_string(self, monkeypatch):
        monkeypatch.setenv("PI_SELFIMPROVE_CLUSTER_MODEL", "anthropic/haiku")
        # spawn raises -> fallback -> exact-string (all differ) -> no cluster
        assert cluster_outcomes(self._FAILS, runner=_fake_runner(raise_exc=OSError("x"))) == []

    def test_run_loop_uses_semantic_clusters(self, monkeypatch):
        monkeypatch.setenv("PI_SELFIMPROVE_CLUSTER_MODEL", "anthropic/haiku")
        payload = json.dumps({"clusters": [{"label": "wrong toolchain", "members": [0, 2]}]})
        result = run_compression_loop(self._FAILS, runner=_fake_runner(_cluster_stream(payload)))
        assert len(result) == 1
        assert "amendment_id" in result[0]


def test_run_loop_prefers_drafted_diff(monkeypatch):
    # #23: when draft_change returns a real diff, run_compression_loop uses it
    # instead of the template guidance block.
    import compression_loop as cl
    monkeypatch.setattr(
        cl, "draft_change",
        lambda learning, evidence, target_file, runner=None: {
            "action": "MODIFY", "old_text": "X", "new_text": "Y", "rationale": "r"},
    )
    outcomes = [
        {"decision_id": "d1", "outcome": "MISMATCH", "domain": "coding", "reason": "same issue here"},
        {"decision_id": "d2", "outcome": "MISMATCH", "domain": "coding", "reason": "same issue here"},
    ]
    result = run_compression_loop(outcomes)  # clustering gate off -> exact-string
    assert len(result) == 1
    assert result[0]["changes"][0]["new_text"] == "Y"
    assert result[0]["changes"][0]["action"] == "MODIFY"
