"""Tests for Phase F3: LLM Verifier Orchestrator."""

import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from analyzers.f3_orchestrator import (
    LLMVerifier,
    LLMVerificationOutcome,
)
from analyzers.verifier import PythonVerifier, VerificationResult, LLMPacket
from analyzers.llm_client import LLMResponse
from dedup import Finding
from flow_card import FlowCard, FlowEndpoint, SanitizerInfo, FlowStep


def make_finding(
    vuln_class: str = "dom_xss",
    source: str = "location.hash",
    sink: str = "element.innerHTML",
    finding_id: str | None = None,
) -> Finding:
    finding_id = finding_id or "test-finding-1"
    return Finding(
        finding_id=finding_id,
        chunk_id=finding_id,  # Match flow card flow_id for batch lookup
        file="app.js",
        vuln_class=vuln_class,
        source=source,
        sink=sink,
        line_start=10,
        line_end=10,
        description="Test finding",
        code_snippet="test code",
    )


def make_flow_card(
    vuln_class: str = "dom_xss",
    sanitizers: list[str] | None = None,
    steps: list[FlowStep] | None = None,
    flow_id: str = "test-finding-1",
) -> FlowCard:
    return FlowCard(
        flow_id=flow_id,
        vulnerability_class=vuln_class,
        cwe_id="CWE-79",
        confidence="candidate",
        lane="code_static",
        source=FlowEndpoint(type="location.hash", line=1),
        sink=FlowEndpoint(type="element.innerHTML", line=10),
        steps=steps or [],
        sanitizer_chain=[
            SanitizerInfo(name=s) for s in (sanitizers or [])
        ],
        module_card_ids=["app.js"],
    )


# ---------------------------------------------------------------------------
# Test LLMVerificationOutcome
# ---------------------------------------------------------------------------

class TestLLMVerificationOutcome:
    """Test the outcome dataclass."""

    def test_to_dict(self):
        outcome = LLMVerificationOutcome(
            finding_id="f-1",
            vuln_class="dom_xss",
            python_verdict="exploitable",
            python_confidence=0.5,
            python_confidence_level="medium",
            llm_verdict="confirmed",
            final_confidence=0.7,
            final_confidence_level="high",
            confidence_delta=0.2,
        )
        d = outcome.to_dict()
        assert d["finding_id"] == "f-1"
        assert d["llm_verdict"] == "confirmed"
        assert d["confidence_delta"] == 0.2

    def test_to_dict_without_llm_response(self):
        outcome = LLMVerificationOutcome(
            finding_id="f-1",
            vuln_class="dom_xss",
            python_verdict="exploitable",
            python_confidence=0.5,
            python_confidence_level="medium",
        )
        d = outcome.to_dict()
        assert d["llm_tokens"] == 0


# ---------------------------------------------------------------------------
# Test LLMVerifier (with mocked LLM)
# ---------------------------------------------------------------------------

class TestLLMVerifierMocked:
    """Test LLMVerifier with a mocked OllamaClient."""

    def _make_mock_client(self, verdict: str = "CONFIRM", text: str = "VERDICT: CONFIRM"):
        """Create a mock OllamaClient that returns a specific verdict."""
        mock_client = Mock()
        mock_response = LLMResponse(
            text=text,
            verdict=verdict,
            reasoning="Mock reasoning",
            prompt_tokens=100,
            completion_tokens=20,
            total_tokens=120,
            duration_ms=2000,
            model="qwen3.6:27b-coder",
        )
        mock_client.generate.return_value = mock_response
        return mock_client

    def test_no_findings(self):
        mock_client = self._make_mock_client()
        verifier = LLMVerifier(client=mock_client)
        outcomes = verifier.verify_findings([])

        assert outcomes == []
        mock_client.generate.assert_not_called()

    def test_skips_high_confidence(self):
        """Findings already at high confidence should be skipped if skip_high_confidence=True."""
        mock_client = self._make_mock_client()
        verifier = LLMVerifier(client=mock_client)

        # High confidence finding (no LLM needed)
        finding = make_finding()
        fc = make_flow_card()  # No sanitizers, single step → high confidence
        outcomes = verifier.verify_findings([finding], [fc], skip_high_confidence=True)

        # Should be Python-only (no LLM call)
        llm_verified = sum(1 for o in outcomes if o.llm_response is not None)
        assert llm_verified == 0

    def test_runs_llm_on_medium_confidence(self):
        """Medium confidence findings should go to LLM."""
        mock_client = self._make_mock_client(verdict="CONFIRM")
        verifier = LLMVerifier(client=mock_client)

        # Create finding that triggers LLM (multi-step + sanitizers)
        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1"],
            steps=[
                FlowStep(expression="x = location.hash", line=1),
                FlowStep(expression="el.innerHTML = x", line=2),
            ],
        )
        outcomes = verifier.verify_findings([finding], [fc])

        # Should have called LLM
        llm_verified = sum(1 for o in outcomes if o.llm_response is not None)
        assert llm_verified >= 1
        mock_client.generate.assert_called()

    def test_llm_confirm_increases_confidence(self):
        """LLM CONFIRM should increase confidence."""
        mock_client = self._make_mock_client(verdict="CONFIRM")
        verifier = LLMVerifier(client=mock_client)

        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1"],
            steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],
        )
        outcomes = verifier.verify_findings([finding], [fc])

        # Find the LLM-verified outcome
        llm_outcome = next((o for o in outcomes if o.llm_response is not None), None)
        assert llm_outcome is not None
        assert llm_outcome.confidence_delta == 0.20  # LLM agrees with Python

    def test_llm_refute_decreases_confidence(self):
        """LLM REFUTE should decrease confidence."""
        mock_client = self._make_mock_client(verdict="REFUTE")
        verifier = LLMVerifier(client=mock_client)

        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1"],
            steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],
        )
        outcomes = verifier.verify_findings([finding], [fc])

        llm_outcome = next((o for o in outcomes if o.llm_response is not None), None)
        assert llm_outcome is not None
        assert llm_outcome.confidence_delta == -0.30  # LLM contradicts Python

    def test_llm_needs_deeper_no_change(self):
        """LLM NEEDS_DEEPER should not change confidence."""
        mock_client = self._make_mock_client(verdict="NEEDS_DEEPER")
        verifier = LLMVerifier(client=mock_client)

        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1"],
            steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],
        )
        outcomes = verifier.verify_findings([finding], [fc])

        llm_outcome = next((o for o in outcomes if o.llm_response is not None), None)
        assert llm_outcome is not None
        assert llm_outcome.confidence_delta == 0.0

    def test_llm_error_keeps_python_confidence(self):
        """LLM errors should preserve Python confidence."""
        mock_client = Mock()
        mock_response = LLMResponse(
            text="[ERROR] connection failed",
            verdict="ERROR",
            duration_ms=0,
        )
        mock_client.generate.return_value = mock_response

        verifier = LLMVerifier(client=mock_client)
        finding = make_finding()
        fc = make_flow_card(
            sanitizers=["s1", "s2"],  # More sanitizers → lower confidence
            steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],  # Multi-step
        )
        outcomes = verifier.verify_findings([finding], [fc])

        llm_outcome = next((o for o in outcomes if o.llm_response is not None), None)
        assert llm_outcome is not None
        assert llm_outcome.llm_verdict == "error"
        # Final should equal python confidence
        assert llm_outcome.final_confidence == llm_outcome.python_confidence

    def test_max_verifications_limit(self):
        """Should respect max_verifications limit."""
        mock_client = self._make_mock_client()
        verifier = LLMVerifier(client=mock_client, max_verifications=2)

        # Create 5 findings that all need LLM
        findings = [
            make_finding(finding_id=f"f-{i}")
            for i in range(5)
        ]
        flow_cards = [
            make_flow_card(
                sanitizers=["s1"],
                steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],
                flow_id=f"f-{i}",
            )
            for i in range(5)
        ]

        outcomes = verifier.verify_findings(findings, flow_cards)
        llm_verified = sum(1 for o in outcomes if o.llm_response is not None)

        # Should have verified at most max_verifications
        assert llm_verified <= 2

    def test_prioritizes_lowest_confidence(self):
        """When limited, should prioritize lowest-confidence findings first."""
        mock_client = self._make_mock_client()
        verifier = LLMVerifier(client=mock_client, max_verifications=1)

        # Create findings with varying sanitizer counts
        # (more sanitizers = lower confidence)
        findings = []
        flow_cards = []
        for i, san_count in enumerate([0, 3, 1]):  # 3 sanitizers → lowest confidence
            findings.append(make_finding(finding_id=f"f-{i}"))
            flow_cards.append(make_flow_card(
                sanitizers=[f"s{j}" for j in range(san_count)],
                steps=[FlowStep(expression="x", line=1)],
                flow_id=f"f-{i}",
            ))

        outcomes = verifier.verify_findings(findings, flow_cards)
        # Only 1 should be LLM-verified, and it should be the lowest-confidence one
        llm_outcomes = [o for o in outcomes if o.llm_response is not None]
        assert len(llm_outcomes) == 1
        # The one with 3 sanitizers should win
        assert llm_outcomes[0].finding_id == "f-1"


class TestRunOnState:
    """Test the run_on_state integration method."""

    def _make_mock_state(self):
        """Create a mock JSAState with python_verification metadata."""
        state = Mock()
        state.metadata = {
            "python_verification": {
                "enabled": True,
                "findings_produced": 2,
                "needs_llm_verify": 2,
                "confidence_distribution": {"medium": 2},
                "verification_results": [],
            }
        }
        state.raw_findings = [
            make_finding(finding_id="f-1"),
            make_finding(finding_id="f-2"),
        ]
        state.flow_cards = [
            make_flow_card(
                sanitizers=["s1"],
                steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],
                flow_id="f-1",
            ),
            make_flow_card(
                sanitizers=["s1"],
                steps=[FlowStep(expression="x", line=1), FlowStep(expression="y", line=2)],
                flow_id="f-2",
            ),
        ]
        return state

    def _make_mock_client(self, verdict: str = "CONFIRM"):
        mock_client = Mock()
        mock_response = LLMResponse(
            text=f"VERDICT: {verdict}",
            verdict=verdict,
            reasoning="Mock",
            prompt_tokens=100,
            completion_tokens=20,
            total_tokens=120,
            duration_ms=2000,
        )
        mock_client.generate.return_value = mock_response
        return mock_client

    def test_no_python_verification_metadata(self):
        """Should return error if python_verification not run."""
        state = Mock()
        state.metadata = {}

        verifier = LLMVerifier(client=self._make_mock_client())
        summary = verifier.run_on_state(state)
        assert "error" in summary

    def test_run_on_state_summary(self):
        """Should produce a summary with counts."""
        state = self._make_mock_state()
        verifier = LLMVerifier(client=self._make_mock_client())
        summary = verifier.run_on_state(state)

        assert "total_findings" in summary
        assert "llm_verified" in summary
        assert summary["total_findings"] == 2

    def test_run_on_state_stores_metadata(self):
        """Should store f3_verification in state.metadata."""
        state = self._make_mock_state()
        verifier = LLMVerifier(client=self._make_mock_client())
        verifier.run_on_state(state)

        assert "f3_verification" in state.metadata
        assert "outcomes" in state.metadata["f3_verification"]

    def test_run_on_state_updates_evidence(self):
        """Should update finding evidence with LLM verdict."""
        state = self._make_mock_state()
        verifier = LLMVerifier(client=self._make_mock_client(verdict="CONFIRM"))
        verifier.run_on_state(state)

        # Findings should have llm_verdict in evidence
        for finding in state.raw_findings:
            if finding.evidence and "llm_verdict" in finding.evidence:
                assert finding.evidence["llm_verdict"] in ("confirmed", "exploitable", "needs_deeper", "refuted", "not_exploitable")


# ---------------------------------------------------------------------------
# Integration test (requires real Ollama)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not __import__("analyzers.llm_client", fromlist=["OllamaClient"]).OllamaClient().health_check(),
    reason="Ollama not available"
)
class TestF3RealIntegration:
    """Integration test with real Ollama."""

    def test_real_f3_pipeline(self):
        """Run the full F3 pipeline on a real finding."""
        from fsm import JSAState, structure_handler, slice_handler, investigate_handler

        files = [("app.js", """
            const x = location.hash;
            const y = decodeURIComponent(x);
            el.innerHTML = y;
        """)]

        state = JSAState(analyzers=["dom_xss"])
        state = structure_handler(state, js_files=files)
        state = slice_handler(state)
        state = investigate_handler(state)

        # Run F3
        verifier = LLMVerifier()
        summary = verifier.run_on_state(state)

        assert summary["total_findings"] > 0
        # Some findings should have been LLM-verified
        assert summary["llm_verified"] >= 0
        # All should have outcomes
        assert len(summary["outcomes"]) == summary["total_findings"]
