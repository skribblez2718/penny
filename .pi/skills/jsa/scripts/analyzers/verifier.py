"""Phase F0: Hybrid Python+LLM Verifier.

The existing `analyzers/*.py` modules are declarative pattern definitions.
This module adds the **execution layer** that:

1. Takes a Finding (from semgrep/SAST/Joern)
2. Uses the corresponding VulnerabilityAnalyzer to assess exploitability
3. Computes a confidence score
4. Decides whether LLM verification is needed
5. Builds an LLM packet if needed

This is the **deterministic** part of the F3 hybrid architecture.
The LLM verification layer (F2) consumes the packets built here.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from analyzers.base import VulnerabilityAnalyzer
from analyzers.dom_xss import DOMXSSAnalyzer
from dedup import Finding
from flow_card import FlowCard


# Registry of all available analyzers
# Auto-populated on first use
_ANALYZER_REGISTRY: dict[str, VulnerabilityAnalyzer] = {}


def _get_analyzer(vuln_class: str) -> VulnerabilityAnalyzer | None:
    """Get the VulnerabilityAnalyzer for a vuln class (lazy-loaded)."""
    if vuln_class in _ANALYZER_REGISTRY:
        return _ANALYZER_REGISTRY[vuln_class]

    # Lazy import to avoid circular deps
    from analyzers.cache_poisoning import CachePoisoningAnalyzer
    from analyzers.clickjacking import ClickjackingAnalyzer
    from analyzers.cors import CORSAnalyzer
    from analyzers.csrf import CSRFAnalyzer
    from analyzers.csti import CSTIAnalyzer
    from analyzers.dom_clobbering import DOMClobberingAnalyzer
    from analyzers.dom_data_manipulation import DOMDataManipulationAnalyzer
    from analyzers.http_header_injection import HTTPHeaderInjectionAnalyzer
    from analyzers.http_smuggling import HTTPSmugglingAnalyzer
    from analyzers.idor import IDORAnalyzer
    from analyzers.insecure_deserialization import InsecureDeserializationAnalyzer
    from analyzers.link_manipulation import LinkManipulationAnalyzer
    from analyzers.open_redirect import OpenRedirectAnalyzer
    from analyzers.postmessage import PostMessageAnalyzer
    from analyzers.prototype_pollution import PrototypePollutionAnalyzer
    from analyzers.reflected_xss import ReflectedXSSAnalyzer
    from analyzers.request_override import RequestOverrideAnalyzer
    from analyzers.secret_disclosure import SecretDisclosureAnalyzer
    from analyzers.sqli import SQLInjectionAnalyzer
    from analyzers.ssrf import SSRFAnalyzer
    from analyzers.stored_xss import StoredXSSAnalyzer

    registry = {
        "dom_xss": DOMXSSAnalyzer(),
        "reflected_xss": ReflectedXSSAnalyzer(),
        "stored_xss": StoredXSSAnalyzer(),
        "prototype_pollution": PrototypePollutionAnalyzer(),
        "csti": CSTIAnalyzer(),
        "dom_clobbering": DOMClobberingAnalyzer(),
        "dom_data_manipulation": DOMDataManipulationAnalyzer(),
        "postmessage": PostMessageAnalyzer(),
        "open_redirect": OpenRedirectAnalyzer(),
        "secret_disclosure": SecretDisclosureAnalyzer(),
        "request_override": RequestOverrideAnalyzer(),
        "link_manipulation": LinkManipulationAnalyzer(),
        "ssrf": SSRFAnalyzer(),
        "sqli": SQLInjectionAnalyzer(),
        "insecure_deserialization": InsecureDeserializationAnalyzer(),
        "http_header_injection": HTTPHeaderInjectionAnalyzer(),
        "cors": CORSAnalyzer(),
        "clickjacking": ClickjackingAnalyzer(),
        "idor": IDORAnalyzer(),
        "cache_poisoning": CachePoisoningAnalyzer(),
        "http_smuggling": HTTPSmugglingAnalyzer(),
        "csrf": CSRFAnalyzer(),
    }

    _ANALYZER_REGISTRY.update(registry)
    return _ANALYZER_REGISTRY.get(vuln_class)


@dataclass
class VerificationResult:
    """Result of running a Python verifier on a Finding."""

    finding: Finding
    analyzer: Optional[VulnerabilityAnalyzer]

    # Python assessment
    python_verdict: str = ""  # "exploitable" | "not_exploitable" | "needs_testing"
    python_difficulty: str = ""  # "low" | "medium" | "high"
    python_preconditions: list[str] = field(default_factory=list)

    # Confidence scoring
    confidence_score: float = 0.0  # 0.0-1.0
    confidence_level: str = "candidate"  # candidate|low|medium|high|confirmed

    # LLM decision
    needs_llm_verify: bool = False  # Should LLM verify?
    needs_llm_deep: bool = False    # Multi-step chain needing deep analysis?
    llm_packet: Optional["LLMPacket"] = None

    # Verification procedure
    verification_procedure: str = ""
    exploitability_assessment: dict = field(default_factory=dict)


@dataclass
class LLMPacket:
    """A compact LLM input packet (Phase F0 protocol)."""

    packet_type: str = "verification"  # verification|deep_analysis|correlation
    vuln_class: str = ""
    system_prompt: str = ""
    reference_excerpt: str = ""
    finding_data: dict = field(default_factory=dict)
    flow_card_data: dict = field(default_factory=dict)
    user_prompt: str = ""
    context: dict = field(default_factory=dict)
    max_output_tokens: int = 500

    def estimate_tokens(self) -> int:
        """Estimate total token count (Qwen 3.5 tokenizer, ~1 token per 4 chars)."""
        import json
        text = (
            self.system_prompt +
            self.reference_excerpt +
            json.dumps(self.finding_data) +
            json.dumps(self.flow_card_data) +
            self.user_prompt +
            json.dumps(self.context)
        )
        return (len(text) // 4) + self.max_output_tokens


def score_confidence(
    finding: Finding,
    python_exploitable: bool,
    python_difficulty: str,
    has_sast_match: bool = False,
    has_joern_flow: bool = False,
    has_runtime_evidence: bool = False,
    sanitizer_count: int = 0,
    taint_hops: int = 1,
) -> float:
    """
    Calculate confidence score (0.0-1.0) based on Python analysis + evidence.

    The Python verifier's exploitability assessment is the primary signal.
    Additional evidence (SAST, Joern, runtime) boosts confidence.
    """
    score = 0.5  # baseline

    # Python verdict is strong signal
    if python_exploitable:
        if python_difficulty == "low":
            score = 0.75  # High confidence
        elif python_difficulty == "medium":
            score = 0.55
        else:
            score = 0.40
    else:
        score = 0.20  # Python says not exploitable

    # +0.15 if SAST tool also flagged it
    if has_sast_match:
        score += 0.15

    # +0.2 if Joern data flow confirms taint path
    if has_joern_flow:
        score += 0.2

    # +0.1 if runtime evidence (Playwright/Caido captured it)
    if has_runtime_evidence:
        score += 0.1

    # -0.1 per sanitizer in chain
    score -= 0.1 * sanitizer_count

    # -0.05 per taint hop beyond first
    if taint_hops > 1:
        score -= 0.05 * (taint_hops - 1)

    return max(0.0, min(1.0, score))


def confidence_level_from_score(score: float) -> str:
    """Convert score to confidence level."""
    if score >= 0.85:
        return "confirmed"
    elif score >= 0.65:
        return "high"
    elif score >= 0.45:
        return "medium"
    elif score >= 0.25:
        return "low"
    else:
        return "candidate"


class PythonVerifier:
    """Run Python verification on a Finding.

    Uses the existing VulnerabilityAnalyzer infrastructure to:
    1. Assess exploitability
    2. Generate verification procedure
    3. Compute confidence score
    4. Decide if LLM verification is needed
    """

    def __init__(self, prompts_dir: Optional[Path] = None):
        """Initialize the verifier.

        Args:
            prompts_dir: Path to assets/prompts/ for reference loading
        """
        if prompts_dir is None:
            self.prompts_dir = Path(__file__).parent.parent / "assets" / "prompts"
        else:
            self.prompts_dir = prompts_dir

    def verify(
        self,
        finding: Finding,
        flow_card: Optional[FlowCard] = None,
    ) -> VerificationResult:
        """Verify a finding using Python analysis.

        Args:
            finding: The Finding to verify
            flow_card: Optional source FlowCard for context

        Returns:
            VerificationResult with verdict, confidence, and optional LLM packet
        """
        vuln_class = finding.vuln_class
        analyzer = _get_analyzer(vuln_class)

        result = VerificationResult(
            finding=finding,
            analyzer=analyzer,
        )

        if analyzer is None:
            # No analyzer for this vuln class - return default
            result.python_verdict = "needs_testing"
            result.python_difficulty = "medium"
            result.confidence_score = 0.3
            result.confidence_level = "low"
            result.needs_llm_verify = True
            return result

        # Assess exploitability using the analyzer
        finding_dict = self._finding_to_dict(finding)
        try:
            exploitability = analyzer.assess_exploitability(finding_dict)
        except Exception:
            exploitability = {
                "exploitable": True,
                "difficulty": "medium",
                "preconditions": [],
            }

        result.python_verdict = (
            "exploitable" if exploitability.get("exploitable", False)
            else "not_exploitable"
        )
        result.python_difficulty = exploitability.get("difficulty", "medium")
        result.python_preconditions = exploitability.get("preconditions", [])
        result.exploitability_assessment = exploitability

        # Generate verification procedure
        try:
            result.verification_procedure = analyzer.get_verification_procedure(finding_dict)
        except Exception:
            result.verification_procedure = "Manual review required"

        # Extract evidence signals from the flow card
        has_sast = False
        has_joern = False
        has_runtime = False
        sanitizer_count = 0
        taint_hops = 1

        if flow_card:
            sources = flow_card.sources or []
            has_sast = any("semgrep" in s for s in sources)
            has_joern = any("joern" in s for s in sources)
            has_runtime = len(flow_card.runtime_evidence) > 0
            sanitizer_count = len(flow_card.sanitizer_chain)
            taint_hops = max(1, len(flow_card.steps))

        # Compute confidence
        result.confidence_score = score_confidence(
            finding=finding,
            python_exploitable=exploitability.get("exploitable", False),
            python_difficulty=exploitability.get("difficulty", "medium"),
            has_sast_match=has_sast,
            has_joern_flow=has_joern,
            has_runtime_evidence=has_runtime,
            sanitizer_count=sanitizer_count,
            taint_hops=taint_hops,
        )
        result.confidence_level = confidence_level_from_score(result.confidence_score)

        # Decide if LLM verification is needed
        # - Confirmed: ship as-is (no LLM)
        # - High: spot-check 20% (LLM is nice but not required)
        # - Medium/Low: LLM verify required
        # - Candidate: LLM deep analysis required
        if result.confidence_level in ("medium", "low"):
            result.needs_llm_verify = True
        elif result.confidence_level == "candidate":
            result.needs_llm_verify = True
            result.needs_llm_deep = True

        # Multi-step chains always benefit from LLM deep analysis
        if taint_hops >= 3:
            result.needs_llm_deep = True

        # Build LLM packet if needed
        if result.needs_llm_verify:
            result.llm_packet = self._build_llm_packet(
                finding=finding,
                flow_card=flow_card,
                analyzer=analyzer,
                result=result,
            )

        return result

    def verify_batch(
        self,
        findings: list[Finding],
        flow_cards: Optional[list[FlowCard]] = None,
    ) -> list[VerificationResult]:
        """Verify multiple findings.

        Args:
            findings: List of findings to verify
            flow_cards: Optional list of source FlowCards (parallel to findings)

        Returns:
            List of VerificationResult objects
        """
        results = []
        flow_card_map = {}

        if flow_cards:
            for fc in flow_cards:
                flow_card_map[fc.flow_id] = fc

        for finding in findings:
            fc = None
            if finding.chunk_id and finding.chunk_id in flow_card_map:
                fc = flow_card_map[finding.chunk_id]
            results.append(self.verify(finding, fc))

        return results

    def _finding_to_dict(self, finding: Finding) -> dict:
        """Convert Finding to dict for analyzer methods."""
        return {
            "finding_id": finding.finding_id,
            "file": finding.file,
            "vuln_class": finding.vuln_class,
            "source": finding.source,
            "sink": finding.sink,
            "line_start": finding.line_start,
            "line_end": finding.line_end,
            "description": finding.description,
            "code_snippet": finding.code_snippet,
            "evidence": finding.evidence,
        }

    def _build_llm_packet(
        self,
        finding: Finding,
        flow_card: Optional[FlowCard],
        analyzer: VulnerabilityAnalyzer,
        result: VerificationResult,
    ) -> LLMPacket:
        """Build an LLM packet for this finding."""
        # Load reference excerpt (cached)
        reference = self._load_reference_excerpt(finding.vuln_class)

        # Build the user prompt
        user_prompt = self._build_verification_prompt(finding, result, flow_card)

        # Serialize flow card
        flow_card_data = {}
        if flow_card:
            flow_card_data = {
                "flow_id": flow_card.flow_id,
                "vuln_class": flow_card.vulnerability_class,
                "cwe_id": flow_card.cwe_id,
                "source": {
                    "type": flow_card.source.type if flow_card.source else None,
                    "detail": flow_card.source.detail if flow_card.source else None,
                    "line": flow_card.source.line if flow_card.source else None,
                },
                "sink": {
                    "type": flow_card.sink.type if flow_card.sink else None,
                    "detail": flow_card.sink.detail if flow_card.sink else None,
                    "line": flow_card.sink.line if flow_card.sink else None,
                    "code_snippet": flow_card.sink.code_snippet if flow_card.sink else None,
                },
                "sanitizers": [s.name for s in flow_card.sanitizer_chain],
                "steps": [
                    {"expression": s.expression, "line": s.line}
                    for s in flow_card.steps
                ],
            }

        return LLMPacket(
            packet_type="deep_analysis" if result.needs_llm_deep else "verification",
            vuln_class=finding.vuln_class,
            system_prompt=analyzer.get_analysis_guide()[:4000],  # First 4K chars
            reference_excerpt=reference,
            finding_data=self._finding_to_dict(finding),
            flow_card_data=flow_card_data,
            user_prompt=user_prompt,
            context={
                "python_verdict": result.python_verdict,
                "python_difficulty": result.python_difficulty,
                "python_preconditions": result.python_preconditions,
                "verification_procedure": result.verification_procedure,
                "confidence_score": result.confidence_score,
            },
            max_output_tokens=1000 if result.needs_llm_deep else 500,
        )

    def _load_reference_excerpt(self, vuln_class: str) -> str:
        """Load reference catalog for a vuln class (truncated for context budget)."""
        ref_path = self.prompts_dir.parent / "assets" / "references" / f"{vuln_class}.md"
        if not ref_path.exists():
            ref_path = self.prompts_dir / f"annie-{vuln_class}.md"

        if ref_path.exists():
            content = ref_path.read_text()
            # Truncate to first 3K chars (~750 tokens)
            if len(content) > 3000:
                content = content[:3000] + "\n\n[... truncated ...]"
            return content
        return ""

    def _build_verification_prompt(
        self,
        finding: Finding,
        result: VerificationResult,
        flow_card: Optional[FlowCard],
    ) -> str:
        """Build the LLM verification prompt."""
        prompt = f"""Verify this potential {finding.vuln_class} vulnerability.

**Python Verdict:** {result.python_verdict} (difficulty: {result.python_difficulty})
**Confidence:** {result.confidence_level} (score: {result.confidence_score:.2f})
**Preconditions:** {', '.join(result.python_preconditions) or 'None'}

**Finding:** {finding.description}
**Source:** {flow_card.source.type if flow_card and flow_card.source else 'unknown'}
**Sink:** {flow_card.sink.type if flow_card and flow_card.sink else 'unknown'}

**Your task:** Determine if this is a true positive.

Consider:
1. Is the source actually user-controllable in this context?
2. Are the sanitizers effective for this sink type?
3. Is the data flow actually reachable?
4. Framework-specific protections (CSP, React auto-escape, etc.)?

**Respond with one of:**
- VERDICT: CONFIRM (exploitable)
- VERDICT: REFUTE (not exploitable - explain why)
- VERDICT: NEEDS_DEEPER (need more context)

Brief justification (2-3 sentences)."""
        return prompt


def get_analyzer(vuln_class: str) -> VulnerabilityAnalyzer | None:
    """Public API: get the analyzer for a vuln class."""
    return _get_analyzer(vuln_class)


def list_analyzers() -> list[str]:
    """List all registered vuln classes."""
    return sorted(_ANALYZER_REGISTRY.keys())
