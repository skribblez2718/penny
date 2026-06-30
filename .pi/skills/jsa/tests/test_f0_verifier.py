"""Tests for Phase F0 Python verifier (hybrid F3 infrastructure).

Tests the PythonVerifier that uses the existing analyzers + adds
the LLM packet decision layer.
"""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from analyzers.verifier import (
    PythonVerifier,
    VerificationResult,
    LLMPacket,
    score_confidence,
    confidence_level_from_score,
    list_analyzers,
    get_analyzer,
)
from dedup import Finding
from flow_card import FlowCard, FlowEndpoint, SanitizerInfo, FlowStep


# ---------------------------------------------------------------------------
# Helper fixtures
# ---------------------------------------------------------------------------

def make_finding(
    vuln_class: str = "dom_xss",
    source: str = "location.hash",
    sink: str = "element.innerHTML",
    description: str = "Test finding",
) -> Finding:
    """Create a Finding for testing."""
    return Finding(
        finding_id="test-finding",
        file="app.js",
        vuln_class=vuln_class,
        source=source,
        sink=sink,
        line_start=10,
        line_end=10,
        description=description,
        code_snippet=f"el.{sink.split('.')[-1]} = {source};",
        evidence={},
    )


def make_flow_card(
    vuln_class: str = "dom_xss",
    source_type: str = "location.hash",
    sink_type: str = "element.innerHTML",
    sanitizers: list[str] | None = None,
    steps: list[FlowStep] | None = None,
    sources: list[str] | None = None,
) -> FlowCard:
    """Create a FlowCard for testing."""
    return FlowCard(
        flow_id="test-finding",  # Match finding.chunk_id
        vulnerability_class=vuln_class,
        cwe_id="CWE-79",
        confidence="candidate",
        lane="code_static",
        source=FlowEndpoint(type=source_type, line=1),
        sink=FlowEndpoint(
            type=sink_type,
            line=10,
            code_snippet=f"el.{sink_type.split('.')[-1]} = x;",
        ),
        steps=steps or [],
        sanitizer_chain=[
            SanitizerInfo(name=s, covers_sink=False) for s in (sanitizers or [])
        ],
        module_card_ids=["app.js"],
        sources=sources or ["dangerous_pattern"],
    )


# ---------------------------------------------------------------------------
# Test confidence scoring
# ---------------------------------------------------------------------------

class TestConfidenceScoring:
    """Test the confidence scoring function."""

    def test_exploitable_low_difficulty(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
        )
        assert score == 0.75  # High confidence

    def test_exploitable_medium_difficulty(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="medium",
        )
        assert score == 0.55  # Medium confidence

    def test_not_exploitable(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=False,
            python_difficulty="low",
        )
        assert score == 0.20  # Low confidence (Python says not exploitable)

    def test_sast_match_boost(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
            has_sast_match=True,
        )
        assert score == 0.90  # 0.75 + 0.15

    def test_joern_flow_boost(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
            has_joern_flow=True,
        )
        assert score == 0.95  # 0.75 + 0.2

    def test_runtime_evidence_boost(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
            has_runtime_evidence=True,
        )
        assert score == 0.85  # 0.75 + 0.1

    def test_sanitizers_penalty(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
            sanitizer_count=2,
        )
        assert score == 0.55  # 0.75 - 0.2

    def test_multi_hop_penalty(self):
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
            taint_hops=3,
        )
        # 0.75 - 0.05 * 2 = 0.65
        assert score == 0.65

    def test_score_bounded(self):
        # Many factors should still stay in [0, 1]
        score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
            has_sast_match=True,
            has_joern_flow=True,
            has_runtime_evidence=True,
            sanitizer_count=10,
            taint_hops=10,
        )
        assert 0.0 <= score <= 1.0


class TestConfidenceLevel:
    """Test confidence level conversion."""

    def test_confirmed(self):
        assert confidence_level_from_score(0.9) == "confirmed"

    def test_high(self):
        assert confidence_level_from_score(0.7) == "high"

    def test_medium(self):
        assert confidence_level_from_score(0.5) == "medium"

    def test_low(self):
        assert confidence_level_from_score(0.3) == "low"

    def test_candidate(self):
        assert confidence_level_from_score(0.1) == "candidate"


# ---------------------------------------------------------------------------
# Test analyzer registry
# ---------------------------------------------------------------------------

class TestAnalyzerRegistry:
    """Test the analyzer registry functions."""

    def test_get_dom_xss_analyzer(self):
        analyzer = get_analyzer("dom_xss")
        assert analyzer is not None
        assert analyzer.vuln_class == "dom_xss"

    def test_get_unknown_analyzer(self):
        analyzer = get_analyzer("nonexistent_class")
        assert analyzer is None

    def test_list_analyzers_populated(self):
        # Force initialization
        get_analyzer("dom_xss")
        analyzers = list_analyzers()
        assert "dom_xss" in analyzers
        assert len(analyzers) >= 5


# ---------------------------------------------------------------------------
# Test PythonVerifier
# ---------------------------------------------------------------------------

class TestPythonVerifier:
    """Test the Python verifier."""

    def test_basic_verification(self):
        verifier = PythonVerifier()
        finding = make_finding()
        result = verifier.verify(finding)

        assert isinstance(result, VerificationResult)
        assert result.finding == finding
        assert result.analyzer is not None
        assert result.analyzer.vuln_class == "dom_xss"

    def test_python_verdict_set(self):
        verifier = PythonVerifier()
        finding = make_finding(source="location.hash", sink="element.innerHTML")
        result = verifier.verify(finding)

        assert result.python_verdict in ("exploitable", "not_exploitable", "needs_testing")
        assert result.python_difficulty in ("low", "medium", "high")

    def test_confidence_scored(self):
        verifier = PythonVerifier()
        finding = make_finding()
        result = verifier.verify(finding)

        assert 0.0 <= result.confidence_score <= 1.0
        assert result.confidence_level in ("candidate", "low", "medium", "high", "confirmed")

    def test_verification_procedure_generated(self):
        verifier = PythonVerifier()
        finding = make_finding()
        result = verifier.verify(finding)

        assert result.verification_procedure
        assert "playwright" in result.verification_procedure.lower() or "verify" in result.verification_procedure.lower()

    def test_no_llm_needed_for_high_confidence(self):
        """High-confidence findings should not need LLM verification."""
        verifier = PythonVerifier()
        finding = make_finding(source="location.hash", sink="element.innerHTML")
        result = verifier.verify(finding)

        # Default dom_xss is "exploitable, low difficulty" → high confidence
        if result.confidence_level in ("confirmed", "high"):
            assert result.needs_llm_verify is False

    def test_llm_needed_for_low_confidence(self):
        """Low-confidence findings should need LLM verification."""
        verifier = PythonVerifier()
        # Create a finding with many sanitizers and multi-hop flow
        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1", "s2", "s3"],
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="y = x", line=2),
                FlowStep(expression="z = y", line=3),
                FlowStep(expression="el.innerHTML = z", line=4),
            ],
        )
        result = verifier.verify(finding, fc)

        # Sanitizers and multi-hop should lower confidence
        assert result.needs_llm_verify is True

    def test_llm_deep_for_3plus_hops(self):
        """Multi-step flows (3+ hops) should trigger deep analysis."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="y = x", line=2),
                FlowStep(expression="z = y", line=3),
                FlowStep(expression="el.innerHTML = z", line=4),
            ],
        )
        result = verifier.verify(finding, fc)

        assert result.needs_llm_deep is True

    def test_unknown_vuln_class(self):
        """Unknown vuln class returns default result."""
        verifier = PythonVerifier()
        finding = make_finding(vuln_class="nonexistent_class")
        result = verifier.verify(finding)

        assert result.analyzer is None
        assert result.python_verdict == "needs_testing"
        assert result.needs_llm_verify is True

    def test_batch_verification(self):
        """Should verify multiple findings in batch."""
        verifier = PythonVerifier()
        findings = [
            make_finding(),
            make_finding(source="location.search"),
            make_finding(source="document.referrer"),
        ]
        flow_cards = [
            make_flow_card(source_type="location.hash"),
            make_flow_card(source_type="location.search"),
            make_flow_card(source_type="document.referrer"),
        ]

        results = verifier.verify_batch(findings, flow_cards)
        assert len(results) == 3
        assert all(isinstance(r, VerificationResult) for r in results)


# ---------------------------------------------------------------------------
# Test LLM packet building
# ---------------------------------------------------------------------------

class TestLLMPacketBuilding:
    """Test the LLM packet protocol."""

    def test_packet_built_when_needed(self):
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1", "s2"],
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.needs_llm_verify:
            assert result.llm_packet is not None
            assert isinstance(result.llm_packet, LLMPacket)

    def test_packet_size_within_budget(self):
        """LLM packets should be under 6K tokens for verification, 15K for deep."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.llm_packet:
            tokens = result.llm_packet.estimate_tokens()
            if result.llm_packet.packet_type == "verification":
                assert tokens < 6000
            elif result.llm_packet.packet_type == "deep_analysis":
                assert tokens < 15000

    def test_packet_contains_finding_data(self):
        """LLM packet should include finding details."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.llm_packet:
            assert result.llm_packet.finding_data
            assert result.llm_packet.finding_data.get("vuln_class") == "dom_xss"

    def test_packet_contains_flow_card(self):
        """LLM packet should include flow card data."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.llm_packet:
            assert result.llm_packet.flow_card_data
            assert result.llm_packet.flow_card_data.get("source")

    def test_packet_contains_user_prompt(self):
        """LLM packet should include the user prompt."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.llm_packet:
            assert result.llm_packet.user_prompt
            assert "VERDICT" in result.llm_packet.user_prompt

    def test_packet_contains_python_verdict_context(self):
        """LLM packet should include Python verdict as context."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.llm_packet:
            assert result.llm_packet.context
            assert "python_verdict" in result.llm_packet.context

    def test_deep_analysis_packet_type(self):
        """Multi-step chains should produce deep_analysis packet."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="y = x", line=2),
                FlowStep(expression="z = y", line=3),
                FlowStep(expression="el.innerHTML = z", line=4),
            ],
        )
        result = verifier.verify(finding, fc)

        if result.llm_packet and result.needs_llm_deep:
            assert result.llm_packet.packet_type == "deep_analysis"
            assert result.llm_packet.max_output_tokens == 1000


# ---------------------------------------------------------------------------
# Test full F3 hybrid scenario
# ---------------------------------------------------------------------------

class TestHybridScenario:
    """Test the full F3 hybrid Python+LLM flow."""

    def test_high_confidence_finding_skips_llm(self):
        """Clear-cut findings should not need LLM."""
        verifier = PythonVerifier()
        finding = make_finding(
            source="location.hash",
            sink="element.innerHTML",
        )
        fc = make_flow_card(source_type="location.hash", sink_type="element.innerHTML")

        result = verifier.verify(finding, fc)
        # Should be high confidence, no LLM needed
        assert result.confidence_level in ("confirmed", "high")
        assert result.needs_llm_verify is False

    def test_medium_confidence_finding_needs_llm(self):
        """Findings with sanitizers may need LLM verification (or not)."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(sanitizers=["someSanitizer"])

        result = verifier.verify(finding, fc)
        # Sanitizers reduce confidence, but dom_xss analyzer may still mark
        # as exploitable. Test that confidence is lower than baseline.
        baseline_score = score_confidence(
            finding=Finding(),
            python_exploitable=True,
            python_difficulty="low",
        )
        # Result should have lower confidence than baseline (due to sanitizers)
        assert result.confidence_score < baseline_score

    def test_multi_step_finding_triggers_deep(self):
        """Multi-step flows should trigger deep analysis."""
        verifier = PythonVerifier()
        finding = make_finding()
        fc = make_flow_card(
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="y = decode(x)", line=2),
                FlowStep(expression="z = sanitize(y)", line=3),
                FlowStep(expression="el.innerHTML = z", line=4),
            ],
        )

        result = verifier.verify(finding, fc)
        assert result.needs_llm_deep is True

    def test_pipeline_with_csp_protection(self):
        """CSP protection should affect exploitability assessment."""
        verifier = PythonVerifier()
        finding = make_finding()
        # Add CSP evidence
        finding.evidence = {"csp_detected": True, "csp_policy": "script-src 'self'"}

        result = verifier.verify(finding)
        # dom_xss analyzer should mark as not exploitable due to CSP
        # (or at least lower confidence)
        assert result.confidence_score < 0.75  # Lower than default

    def test_real_world_example_with_full_metadata(self):
        """A realistic finding with all metadata should verify correctly."""
        verifier = PythonVerifier()
        finding = Finding(
            finding_id="abc-123",
            file="https://example.com/app.js",
            vuln_class="dom_xss",
            source="location.hash",
            sink="element.innerHTML",
            line_start=42,
            line_end=42,
            description="location.hash flows to element.innerHTML",
            code_snippet="document.getElementById('output').innerHTML = location.hash;",
            evidence={},
        )
        fc = make_flow_card(
            source_type="location.hash",
            sink_type="element.innerHTML",
        )
        fc.sink.code_snippet = "document.getElementById('output').innerHTML = location.hash;"
        fc.sink.line = 42

        result = verifier.verify(finding, fc)

        # Should have full metadata
        assert result.verification_procedure
        assert result.exploitability_assessment
        assert result.python_verdict
        assert result.python_difficulty
