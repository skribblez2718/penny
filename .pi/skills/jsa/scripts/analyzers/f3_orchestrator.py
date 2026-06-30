"""LLM Verifier Orchestrator (Phase F3)

The F3 hybrid architecture orchestrator:
1. Takes the python_verification results from investigate_handler
2. Identifies findings that need LLM verification
3. Executes the LLM packets via OllamaClient
4. Updates finding confidence based on LLM verdicts
5. Stores LLM responses in metadata for traceability

This is the complete F3 pipeline:
  Python Engine (verifier.py) → LLM Packet → Ollama → Confidence Update
"""

from __future__ import annotations

import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from dedup import Finding
from analyzers.verifier import (
    PythonVerifier,
    VerificationResult,
    LLMPacket,
    score_confidence,
    confidence_level_from_score,
)
from analyzers.llm_client import (
    OllamaClient,
    LLMResponse,
    normalize_verdict,
    verdict_to_confidence_delta,
)


@dataclass
class LLMVerificationOutcome:
    """Result of running an LLM verification on a single finding."""

    finding_id: str
    vuln_class: str

    # Python pre-LLM state
    python_verdict: str
    python_confidence: float
    python_confidence_level: str

    # LLM response
    llm_response: Optional[LLMResponse] = None
    llm_verdict: str = ""  # Normalized: confirmed/refuted/etc
    llm_reasoning: str = ""

    # Final state (after LLM)
    final_confidence: float = 0.0
    final_confidence_level: str = ""
    confidence_delta: float = 0.0

    # Timing
    duration_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "finding_id": self.finding_id,
            "vuln_class": self.vuln_class,
            "python_verdict": self.python_verdict,
            "python_confidence": self.python_confidence,
            "python_confidence_level": self.python_confidence_level,
            "llm_verdict": self.llm_verdict,
            "llm_reasoning": self.llm_reasoning,
            "final_confidence": self.final_confidence,
            "final_confidence_level": self.final_confidence_level,
            "confidence_delta": self.confidence_delta,
            "duration_ms": self.duration_ms,
            "llm_tokens": self.llm_response.total_tokens if self.llm_response else 0,
        }


class LLMVerifier:
    """Orchestrate the LLM verification layer of the F3 hybrid pipeline.

    Given a list of findings (already Python-verified), this class:
    1. Selects which findings need LLM verification
    2. Builds and sends LLM packets
    3. Parses verdicts
    4. Updates finding confidence
    5. Returns outcomes for each verified finding
    """

    def __init__(
        self,
        client: Optional[OllamaClient] = None,
        verifier: Optional[PythonVerifier] = None,
        max_verifications: int = 500,
    ):
        """Initialize the LLM verifier.

        Args:
            client: OllamaClient (uses default if None)
            verifier: PythonVerifier (creates new if None)
            max_verifications: Max LLM calls per run (safety limit)
        """
        self.client = client or OllamaClient()
        self.verifier = verifier or PythonVerifier()
        self.max_verifications = max_verifications

    def verify_findings(
        self,
        findings: list[Finding],
        flow_cards: Optional[list] = None,
        skip_high_confidence: bool = True,
    ) -> list[LLMVerificationOutcome]:
        """Run Python + LLM verification on a list of findings.

        This is the full F3 hybrid pipeline for a batch of findings.

        Args:
            findings: List of findings to verify
            flow_cards: Optional source flow cards
            skip_high_confidence: If True, skip findings already at high/confirmed

        Returns:
            List of LLMVerificationOutcome objects
        """
        # Step 1: Run Python verification on all findings
        python_results = self.verifier.verify_batch(findings, flow_cards)

        # Build a map of finding_id -> Python result
        result_map = {r.finding.finding_id: r for r in python_results}

        # Step 2: Select which findings need LLM verification
        to_verify = []
        for result in python_results:
            # Skip if no LLM packet needed
            if not result.needs_llm_verify:
                continue
            # Skip if no packet was built
            if result.llm_packet is None:
                continue
            # Optionally skip high-confidence findings
            if skip_high_confidence and result.confidence_level in ("confirmed", "high"):
                continue
            to_verify.append(result)

        # Apply safety limit
        if len(to_verify) > self.max_verifications:
            # Prioritize by confidence (lowest first - these need LLM most)
            to_verify.sort(key=lambda r: r.confidence_score)
            to_verify = to_verify[:self.max_verifications]

        # Step 3: Execute LLM verifications
        outcomes = []
        for python_result in to_verify:
            outcome = self._verify_one(python_result)
            outcomes.append(outcome)

        # Also record skipped findings (no LLM needed) so caller has complete picture
        verified_ids = {o.finding_id for o in outcomes}
        for result in python_results:
            if result.finding.finding_id not in verified_ids:
                # No LLM needed - record the Python-only outcome
                outcomes.append(LLMVerificationOutcome(
                    finding_id=result.finding.finding_id,
                    vuln_class=result.finding.vuln_class,
                    python_verdict=result.python_verdict,
                    python_confidence=result.confidence_score,
                    python_confidence_level=result.confidence_level,
                    final_confidence=result.confidence_score,
                    final_confidence_level=result.confidence_level,
                    confidence_delta=0.0,
                    duration_ms=0,
                ))

        return outcomes

    def _verify_one(self, python_result: VerificationResult) -> LLMVerificationOutcome:
        """Run LLM verification on a single Python-verified finding."""
        start = time.time()

        outcome = LLMVerificationOutcome(
            finding_id=python_result.finding.finding_id,
            vuln_class=python_result.finding.vuln_class,
            python_verdict=python_result.python_verdict,
            python_confidence=python_result.confidence_score,
            python_confidence_level=python_result.confidence_level,
        )

        if python_result.llm_packet is None:
            outcome.duration_ms = int((time.time() - start) * 1000)
            return outcome

        packet = python_result.llm_packet

        try:
            # Call the LLM
            llm_response = self.client.generate(
                prompt=packet.user_prompt,
                system=packet.system_prompt,
                max_tokens=packet.max_output_tokens,
                temperature=0.1,
            )
            outcome.llm_response = llm_response
            outcome.llm_verdict = normalize_verdict(llm_response.verdict)
            outcome.llm_reasoning = llm_response.reasoning

            # Update confidence based on LLM verdict
            if llm_response.verdict and llm_response.verdict != "ERROR":
                delta = verdict_to_confidence_delta(
                    outcome.llm_verdict,
                    python_result.python_verdict,
                )
                outcome.confidence_delta = delta
                outcome.final_confidence = max(
                    0.0, min(1.0, python_result.confidence_score + delta)
                )
            else:
                # LLM error - keep Python confidence
                outcome.final_confidence = python_result.confidence_score

            outcome.final_confidence_level = confidence_level_from_score(
                outcome.final_confidence
            )

        except Exception as e:
            outcome.llm_reasoning = f"LLM call failed: {e}"
            outcome.final_confidence = python_result.confidence_score
            outcome.final_confidence_level = python_result.confidence_level

        outcome.duration_ms = int((time.time() - start) * 1000)
        return outcome

    def run_on_state(self, state) -> dict:
        """Run F3 verification on a JSAState.

        Consumes python_verification metadata from investigate_handler,
        runs LLM verifications, and updates state.metadata["f3_verification"].

        Args:
            state: JSAState with python_verification metadata

        Returns:
            Summary dict with counts and totals
        """
        if "python_verification" not in state.metadata:
            return {"error": "No python_verification metadata found"}

        pv = state.metadata["python_verification"]
        if not pv.get("enabled"):
            return {"error": "Python verification not enabled"}

        # Get the findings from state.raw_findings
        findings = state.raw_findings
        flow_cards = state.flow_cards

        if not findings:
            return {"status": "no_findings", "verified": 0}

        # Run the hybrid pipeline
        outcomes = self.verify_findings(findings, flow_cards)

        # Aggregate stats
        llm_verified = sum(1 for o in outcomes if o.llm_response is not None)
        llm_confirmed = sum(1 for o in outcomes if o.llm_verdict == "confirmed" or o.llm_verdict == "exploitable")
        llm_refuted = sum(1 for o in outcomes if o.llm_verdict == "refuted" or o.llm_verdict == "not_exploitable")
        total_tokens = sum(o.llm_response.total_tokens for o in outcomes if o.llm_response)
        total_duration = sum(o.duration_ms for o in outcomes)

        # Build summary
        summary = {
            "total_findings": len(findings),
            "llm_verified": llm_verified,
            "python_only": len(outcomes) - llm_verified,
            "llm_confirmed": llm_confirmed,
            "llm_refuted": llm_refuted,
            "total_llm_tokens": total_tokens,
            "total_duration_ms": total_duration,
            "outcomes": [o.to_dict() for o in outcomes],
        }

        # Update state.metadata
        state.metadata["f3_verification"] = summary

        # Apply confidence updates to state.raw_findings
        outcome_map = {o.finding_id: o for o in outcomes}
        for finding in state.raw_findings:
            if finding.finding_id in outcome_map:
                outcome = outcome_map[finding.finding_id]
                # Store LLM verdict in evidence
                if not finding.evidence:
                    finding.evidence = {}
                finding.evidence["llm_verdict"] = outcome.llm_verdict
                finding.evidence["llm_reasoning"] = outcome.llm_reasoning[:200] if outcome.llm_reasoning else ""
                finding.evidence["f3_confidence_delta"] = outcome.confidence_delta
                finding.evidence["f3_final_confidence"] = outcome.final_confidence
                # Note: We don't mutate the existing confidence field
                # because downstream merge uses that for dedup

        return summary
