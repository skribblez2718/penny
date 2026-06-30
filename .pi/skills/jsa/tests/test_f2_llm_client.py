"""Tests for Phase F2: LLM client (Ollama wrapper)."""

import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from analyzers.llm_client import (
    OllamaClient,
    LLMResponse,
    normalize_verdict,
    verdict_to_confidence_delta,
    VERDICT_MAP,
)


class TestLLMResponse:
    """Test LLMResponse dataclass."""

    def test_to_dict(self):
        resp = LLMResponse(
            text="VERDICT: CONFIRM",
            verdict="CONFIRM",
            confidence="high",
            reasoning="Looks exploitable",
            prompt_tokens=100,
            completion_tokens=20,
            total_tokens=120,
            duration_ms=2000,
            model="qwen3.6:27b-coder",
        )
        d = resp.to_dict()
        assert d["text"] == "VERDICT: CONFIRM"
        assert d["verdict"] == "CONFIRM"
        assert d["prompt_tokens"] == 100
        assert d["total_tokens"] == 120


class TestVerdictParsing:
    """Test the response parser extracts verdicts correctly."""

    def setup_method(self):
        self.client = OllamaClient()

    def test_parse_confirm_verdict(self):
        text = "VERDICT: CONFIRM\n\nThe input is clearly exploitable."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "CONFIRM"

    def test_parse_refute_verdict(self):
        text = "VERDICT: REFUTE\n\nThe sanitizer is effective."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "REFUTE"

    def test_parse_needs_deeper(self):
        text = "VERDICT: NEEDS_DEEPER\n\nNeed to see more context."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "NEEDS_DEEPER"

    def test_parse_exploitable(self):
        text = "VERDICT: EXPLOITABLE\n\nThis can be exploited."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "EXPLOITABLE"

    def test_parse_not_exploitable(self):
        text = "VERDICT: NOT_EXPLOITABLE\n\nCSP blocks this."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "NOT_EXPLOITABLE"

    def test_parse_with_confidence(self):
        text = "VERDICT: CONFIRM\nCONFIDENCE: high\n\nClear vulnerability."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "CONFIRM"
        assert confidence == "high"

    def test_parse_with_reasoning_keyword(self):
        text = "VERDICT: CONFIRM\nREASONING: This is a clear DOM XSS."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "CONFIRM"
        assert "DOM XSS" in reasoning

    def test_parse_no_verdict(self):
        text = "This is a general analysis without a clear verdict."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == ""

    def test_parse_lowercase_verdict(self):
        text = "verdict: confirm\nThis is exploitable."
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "CONFIRM"

    def test_parse_chain_detected(self):
        text = "VERDICT: CHAIN_DETECTED\nCHAIN_TYPE: chained"
        verdict, confidence, reasoning = self.client._parse_response(text)
        assert verdict == "CHAIN_DETECTED"


class TestVerdictNormalization:
    """Test verdict normalization."""

    def test_normalize_confirm(self):
        assert normalize_verdict("CONFIRM") == "confirmed"

    def test_normalize_refute(self):
        assert normalize_verdict("REFUTE") == "refuted"

    def test_normalize_exploitable(self):
        assert normalize_verdict("EXPLOITABLE") == "exploitable"

    def test_normalize_not_exploitable(self):
        assert normalize_verdict("NOT_EXPLOITABLE") == "not_exploitable"

    def test_normalize_chain_detected(self):
        assert normalize_verdict("CHAIN_DETECTED") == "chain_detected"

    def test_normalize_unknown(self):
        assert normalize_verdict("UNKNOWN") == "unknown"


class TestConfidenceDelta:
    """Test the confidence delta computation."""

    def test_llm_confirms_python_exploitable(self):
        delta = verdict_to_confidence_delta("confirmed", "exploitable")
        assert delta == 0.20  # Strong agreement

    def test_llm_refutes_python_exploitable(self):
        delta = verdict_to_confidence_delta("refuted", "exploitable")
        assert delta == -0.30  # LLM contradicts Python

    def test_llm_neutral(self):
        delta = verdict_to_confidence_delta("needs_deeper", "exploitable")
        assert delta == 0.0

    def test_llm_agrees_not_exploitable(self):
        delta = verdict_to_confidence_delta("refuted", "not_exploitable")
        assert delta == 0.20  # Both agree

    def test_llm_disagrees_not_exploitable(self):
        delta = verdict_to_confidence_delta("confirmed", "not_exploitable")
        assert delta == -0.20


class TestOllamaClient:
    """Test the OllamaClient wrapper."""

    def test_initialization(self):
        client = OllamaClient()
        assert client.model == "qwen3.6:27b-coder"
        assert client.base_url == "http://localhost:11434"
        assert client.timeout == 600

    def test_custom_model(self):
        client = OllamaClient(model="llama3.1:8b")
        assert client.model == "llama3.1:8b"

    def test_health_check(self):
        """Health check should not raise."""
        client = OllamaClient()
        # Just check it doesn't crash - actual health depends on Ollama running
        result = client.health_check()
        assert isinstance(result, bool)

    def test_generate_includes_think_false(self):
        """Generate should disable thinking mode to save tokens."""
        client = OllamaClient()
        # Mock the HTTP call to inspect the payload
        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_resp = Mock()
            mock_resp.read.return_value = b'{"response": "test", "prompt_eval_count": 5, "eval_count": 3}'
            mock_resp.__enter__ = Mock(return_value=mock_resp)
            mock_resp.__exit__ = Mock(return_value=False)
            mock_urlopen.return_value = mock_resp

            client.generate(prompt="test", system="sys", max_tokens=10)

            # Inspect the request that was made
            call_args = mock_urlopen.call_args
            request = call_args[0][0]
            import json
            body = json.loads(request.data)
            assert body.get("think") is False


# Integration test - only runs if Ollama is available
@pytest.mark.skipif(
    not OllamaClient().health_check(),
    reason="Ollama not available"
)
class TestOllamaIntegration:
    """Integration tests against real Ollama."""

    def test_simple_call(self):
        """Should make a real call and get a response."""
        client = OllamaClient(model="qwen3.6:27b-coder")
        resp = client.generate(
            prompt="Respond with exactly: VERDICT: CONFIRM",
            system="You are a security analyzer. Follow instructions exactly.",
            max_tokens=20,
            temperature=0.0,
        )
        assert "CONFIRM" in resp.text or resp.verdict == "CONFIRM"
        assert resp.total_tokens > 0
        assert resp.duration_ms > 0

    def test_thinking_disabled(self):
        """With think=false, response should be direct (not empty)."""
        client = OllamaClient(model="qwen3.6:27b-coder")
        resp = client.generate(
            prompt="Say hello",
            system="Respond directly.",
            max_tokens=10,
            temperature=0.0,
        )
        # Should have non-empty response
        assert resp.text.strip() != ""

    def test_verdict_parsing_real_response(self):
        """Real LLM response should be parseable."""
        client = OllamaClient(model="qwen3.6:27b-coder")
        resp = client.generate(
            prompt="Is 'el.innerHTML = location.hash' vulnerable? Respond with VERDICT: CONFIRM or VERDICT: REFUTE then a one-sentence reason.",
            system="You are a security analyzer. Follow the format exactly.",
            max_tokens=50,
            temperature=0.0,
        )
        assert resp.verdict in ("CONFIRM", "REFUTE", "NEEDS_DEEPER")
        assert resp.reasoning
