"""
jsa Skill — VulnerabilityAnalyzer Base Class

Abstract interface for all per-vuln-class analyzers.
Each analyzer encapsulates WHAT to look for and HOW to verify.

Architecture: plans/jsa-implementation/04-generalized-pipeline.md §2.2
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class SourceSink:
    """A source→sink pair defining a vulnerability pattern."""
    name: str                           # "location.hash → innerHTML"
    sources: list[str] = field(default_factory=list)
    sinks: list[str] = field(default_factory=list)
    severity: str = "medium"            # "critical", "high", "medium", "low"
    cwe: str = ""


@dataclass
class PayloadTemplate:
    """A PoC payload template for verification."""
    id: str
    description: str
    template: str       # May contain {source}, {sink}, {url} placeholders
    encoding: str = "none"             # "none", "url", "html", "js_string", "template_literal"
    target_context: str = "html"       # "html", "attribute", "js_string", "js_code", "url"


# ---------------------------------------------------------------------------
# Analyzer prompts directory
# ---------------------------------------------------------------------------

_PROMPTS_DIR = Path(__file__).parent.parent.parent / "assets" / "prompts"


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------

class VulnerabilityAnalyzer(ABC):
    """
    Pluggable analyzer for a specific vulnerability class.
    
    Each analyzer encapsulates:
    - WHAT to look for (sources, sinks, scanner configurations)
    - HOW to verify (payload templates, browser procedures)
    
    The pipeline handles all mechanical work (splitting, dispatch, merging).
    """
    
    # ── Identity ──
    
    @property
    @abstractmethod
    def vuln_class(self) -> str:
        """Unique identifier: "dom_xss", "prototype_pollution", etc."""
        ...
    
    @property
    @abstractmethod
    def display_name(self) -> str:
        """Human-readable: "DOM-Based Cross-Site Scripting" """
        ...
    
    @property
    def is_file_level(self) -> bool:
        """True if this analyzer operates on JS files, False for page-level."""
        return True
    
    @property
    def is_page_level(self) -> bool:
        return not self.is_file_level
    
    # ── Pattern Definitions ──
    
    @abstractmethod
    def get_source_sink_pairs(self) -> list[SourceSink]:
        """Define what source→sink patterns constitute this vulnerability."""
        ...
    
    @abstractmethod
    def get_semgrep_rulesets(self) -> list[str]:
        """Which semgrep registry rulesets to use."""
        ...
    
    @abstractmethod
    def get_custom_scanners(self) -> list[str]:
        """Which Python scanner modules to invoke."""
        ...
    
    # ── Analysis Guide ──
    
    @abstractmethod
    def get_analysis_guide(self) -> str:
        """
        Return the analysis guide markdown for the worker agent.
        This is injected as skillContext in the worker's system prompt.
        """
        ...
    
    # ── Pre-Filtering ──
    
    def get_sink_patterns(self) -> list[str]:
        """
        Quick-grep patterns for pre-filtering files.
        Files without ANY of these patterns are skipped before chunking.
        """
        sinks = []
        for ss in self.get_source_sink_pairs():
            sinks.extend(ss.sinks)
        return list(set(sinks))
    
    def get_source_patterns(self) -> list[str]:
        """Quick-grep patterns for sources."""
        sources = []
        for ss in self.get_source_sink_pairs():
            sources.extend(ss.sources)
        return list(set(sources))
    
    # ── Verification ──
    
    @abstractmethod
    def get_payload_templates(self) -> list[PayloadTemplate]:
        """PoC payloads for verifying findings in the browser."""
        ...
    
    @abstractmethod
    def get_verification_procedure(self, finding: dict) -> str:
        """Generate step-by-step verification procedure for a specific finding."""
        ...
    
    @abstractmethod
    def assess_exploitability(self, finding: dict) -> dict:
        """
        Assess whether a finding is actually exploitable.
        Returns: { exploitable: bool, difficulty: str, preconditions: list[str] }
        """
        ...
    
    # ── Severity ──
    
    @abstractmethod
    def get_cvss_base(self, finding: dict) -> dict:
        """Return base CVSS 4.0 vector for this vulnerability class."""
        ...
    
    @property
    @abstractmethod
    def default_severity(self) -> str:
        """Default severity if CVSS can't be computed."""
        ...
    
    # ── Helpers ──
    
    def _load_prompt(self, prompt_name: str) -> str:
        """Load a prompt file from assets/prompts/."""
        path = _PROMPTS_DIR / prompt_name
        if path.exists():
            return path.read_text()
        return f"# {self.display_name}\n\nAnalyze code for {self.vuln_class} vulnerabilities.\n"
    
    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(vuln_class={self.vuln_class})"
