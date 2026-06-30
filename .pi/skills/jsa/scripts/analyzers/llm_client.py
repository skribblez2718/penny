"""LLM Client (Phase F2)

Wrapper around the Ollama API for executing LLM packets.
Designed for qwen3.6:27b-coder with Q8_0 KV cache at 262K context.

Features:
- Streaming + non-streaming modes
- Automatic retry on transient errors
- Token budget enforcement
- Response parsing (verdict extraction)
- Prompt caching (Ollama native)
- Timeout handling for long-running calls

Usage:
    client = OllamaClient(model="qwen3.6:27b-coder")
    response = client.generate(
        prompt="...",
        system="...",
        max_tokens=500,
    )
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import urllib.request
import urllib.error


# Default Ollama endpoint
DEFAULT_OLLAMA_URL = "http://localhost:11434"


@dataclass
class LLMResponse:
    """Response from an LLM call."""

    text: str = ""
    verdict: str = ""  # Extracted verdict (CONFIRM/REFUTE/etc)
    confidence: str = ""  # LLM's confidence
    reasoning: str = ""  # LLM's explanation

    # Token usage
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    # Timing
    duration_ms: int = 0

    # Metadata
    model: str = ""
    cached: bool = False  # Whether this was a cache hit

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "verdict": self.verdict,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "duration_ms": self.duration_ms,
            "model": self.model,
            "cached": self.cached,
        }


class OllamaClient:
    """Client for the Ollama API.

    Handles HTTP-level concerns, retries, and response parsing.
    The high-level orchestration (verdict extraction, etc.) lives here.
    """

    def __init__(
        self,
        model: str = "qwen3.6:27b-coder",
        base_url: str = DEFAULT_OLLAMA_URL,
        timeout: int = 600,
    ):
        """Initialize the client.

        Args:
            model: Ollama model name
            base_url: Ollama server URL
            timeout: Request timeout in seconds
        """
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def generate(
        self,
        prompt: str,
        system: str = "",
        max_tokens: int = 500,
        temperature: float = 0.1,
        max_retries: int = 2,
    ) -> LLMResponse:
        """Generate a completion.

        Args:
            prompt: The user prompt
            system: System prompt (for prompt caching, keep this stable)
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature (low for security analysis)
            max_retries: Number of retries on transient failures

        Returns:
            LLMResponse with text, verdict, timing, etc.
        """
        url = f"{self.base_url}/api/generate"
        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "num_predict": max_tokens,
                "temperature": temperature,
            },
        }
        if system:
            payload["system"] = system
        # Disable thinking mode for structured output (saves tokens)
        # qwen3 models use thinking by default; we want direct output
        payload["think"] = False

        last_error = None
        for attempt in range(max_retries + 1):
            try:
                start = time.time()
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    body = resp.read().decode("utf-8")
                    result = json.loads(body)
                duration_ms = int((time.time() - start) * 1000)

                # Parse Ollama response
                text = result.get("response", "")
                # Some models put output in "thinking" field
                if not text and "thinking" in result:
                    text = result.get("thinking", "")
                prompt_tokens = result.get("prompt_eval_count", 0)
                completion_tokens = result.get("eval_count", 0)
                cached = result.get("cached", False)

                # Extract verdict
                verdict, confidence, reasoning = self._parse_response(text)

                return LLMResponse(
                    text=text,
                    verdict=verdict,
                    confidence=confidence,
                    reasoning=reasoning,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=prompt_tokens + completion_tokens,
                    duration_ms=duration_ms,
                    model=self.model,
                    cached=cached,
                )

            except urllib.error.URLError as e:
                last_error = e
                if attempt < max_retries:
                    time.sleep(1.0 * (attempt + 1))  # Backoff
                    continue
                break
            except (json.JSONDecodeError, KeyError) as e:
                last_error = e
                break

        # All retries failed
        return LLMResponse(
            text=f"[ERROR] {last_error}",
            verdict="ERROR",
            duration_ms=0,
            model=self.model,
        )

    def _parse_response(self, text: str) -> tuple[str, str, str]:
        """Parse LLM response to extract verdict, confidence, reasoning.

        Expected format:
            VERDICT: CONFIRM
            CONFIDENCE: high
            REASONING: explanation...

        Returns:
            (verdict, confidence, reasoning)
        """
        verdict = ""
        confidence = ""
        reasoning = ""

        # Look for VERDICT: line
        verdict_match = re.search(
            r"VERDICT\s*:\s*(CONFIRM|REFUTE|NEEDS_DEEPER|EXPLOITABLE|NOT_EXPLOITABLE|NEEDS_TESTING|CHAIN_DETECTED|REJECT)",
            text,
            re.IGNORECASE,
        )
        if verdict_match:
            verdict = verdict_match.group(1).upper()

        # Look for CONFIDENCE: line
        conf_match = re.search(
            r"CONFIDENCE\s*:\s*(\w+)",
            text,
            re.IGNORECASE,
        )
        if conf_match:
            confidence = conf_match.group(1).lower()

        # Everything after VERDICT/REASONING is the reasoning
        reasoning_match = re.search(
            r"REASONING\s*:?\s*(.+?)(?:\n\n|$)",
            text,
            re.IGNORECASE | re.DOTALL,
        )
        if reasoning_match:
            reasoning = reasoning_match.group(1).strip()
        else:
            # Use everything after the VERDICT line as reasoning
            if verdict_match:
                after = text[verdict_match.end():].strip()
                reasoning = after

        return verdict, confidence, reasoning

    def health_check(self) -> bool:
        """Check if Ollama is reachable."""
        try:
            url = f"{self.base_url}/api/tags"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
            return True
        except Exception:
            return False


# Verdict normalization
VERDICT_MAP = {
    # Verification packets
    "CONFIRM": "confirmed",
    "REFUTE": "refuted",
    "NEEDS_DEEPER": "needs_deeper",
    # Deep analysis packets
    "EXPLOITABLE": "exploitable",
    "NOT_EXPLOITABLE": "not_exploitable",
    "NEEDS_TESTING": "needs_testing",
    # Correlation packets
    "CHAIN_DETECTED": "chain_detected",
    "REJECT": "rejected",
}


def normalize_verdict(verdict: str) -> str:
    """Normalize a verdict to its canonical form."""
    return VERDICT_MAP.get(verdict.upper(), verdict.lower())


def verdict_to_confidence_delta(verdict: str, python_verdict: str) -> float:
    """Compute confidence delta based on LLM verdict vs Python verdict.

    Args:
        verdict: Normalized LLM verdict
        python_verdict: Original Python verdict

    Returns:
        Confidence delta (e.g., +0.2 for LLM confirm, -0.2 for LLM refute)
    """
    if verdict == "confirmed" or verdict == "exploitable":
        # LLM agrees with Python that it's exploitable
        if python_verdict == "exploitable":
            return 0.20  # Strong agreement
        else:
            return -0.20  # LLM disagrees with Python
    elif verdict == "refuted" or verdict == "not_exploitable":
        # LLM says not exploitable
        if python_verdict == "exploitable":
            return -0.30  # LLM contradicts Python
        else:
            return 0.20  # Both agree it's not exploitable
    elif verdict == "needs_deeper" or verdict == "needs_testing":
        # LLM is uncertain - no change
        return 0.0
    else:
        return 0.0
