"""jsa Skill — FlowCard dataclass

Represents one vulnerability-class candidate data flow.

FlowCards are built by the SLICE phase. Primary data sources:
- Joern DataFlowSlice (when available, subprocess subprocess subprocess subprocess subprocess subprocess subprocess)
- correlate_evidence.py (CorrelationEdge for evidence)
- scanner_dedup.py (SAST findings)

Used by: ALL lane agents (code-static, page-DOM, network-behavior).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class FlowEndpoint:
    """A source or sink endpoint in a data flow."""
    type: str = ""  # e.g., "location.search", "element.innerHTML", "fetch"
    page_card_id: Optional[str] = None  # FK to PageCard
    module_card_id: Optional[str] = None  # FK to ModuleCard
    detail: str = ""
    code_snippet: str = ""
    line: int = 0
    column: int = 0


@dataclass
class FlowStep:
    """One step in a source→sink data flow path."""
    step_type: str = ""  # "assignment" | "call" | "return" | "property_access" | "condition"
    module_card_id: Optional[str] = None
    expression: str = ""
    line: int = 0
    variable: Optional[str] = None
    # For Joern-derived steps
    joern_node_id: Optional[int] = None


@dataclass
class SanitizerInfo:
    """A sanitizer that may break a data flow."""
    name: str = ""  # e.g., "DOMPurify.sanitize"
    location_line: int = 0
    covers_sink: bool = False  # Whether the sanitizer covers the detected sink
    note: str = ""


@dataclass
class RuntimeEvidence:
    """Runtime evidence for a flow (from Playwright/Caido)."""
    page_loaded_sink: bool = False
    request_urls: list[str] = field(default_factory=list)
    event_listeners: list[str] = field(default_factory=list)
    console_errors: list[str] = field(default_factory=list)
    # Timestamp of when the evidence was captured
    captured_at: str = ""


@dataclass
class FlowCard:
    """One vuln-class candidate data flow."""
    flow_id: str = ""  # UUID
    vulnerability_class: str = ""  # e.g., "dom_xss", "prototype_pollution"
    cwe_id: Optional[str] = None

    confidence: str = "candidate"  # "candidate" | "probable" | "confirmed"

    # Lane assignment (decided in SLICE)
    lane: str = ""  # "code_static" | "page_dom" | "network_behavior"

    source: Optional[FlowEndpoint] = None
    sink: Optional[FlowEndpoint] = None

    steps: list[FlowStep] = field(default_factory=list)
    sanitizer_chain: list[SanitizerInfo] = field(default_factory=list)

    # Foreign keys
    module_card_ids: list[str] = field(default_factory=list)
    page_card_ids: list[str] = field(default_factory=list)

    # Evidence (from correlate_evidence)
    evidence: list[Any] = field(default_factory=list)  # list[CorrelationEdge]

    # Runtime evidence (from Playwright/Caido)
    runtime_evidence: list[RuntimeEvidence] = field(default_factory=list)

    severity: str = ""  # "critical" | "high" | "medium" | "low" | "info"
    cvss_score: Optional[float] = None
    cwe_vuln: Optional[str] = None  # Specific CWE if known

    # Provenance
    discovered: str = ""  # ISO timestamp
    confirmed: bool = False
    sources: list[str] = field(default_factory=list)  # "joern", "correlation", "sast"

    def to_dict(self) -> dict:
        return _to_dict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "FlowCard":
        card = cls(
            flow_id=d.get("flow_id", ""),
            vulnerability_class=d.get("vulnerability_class", ""),
            cwe_id=d.get("cwe_id"),
            confidence=d.get("confidence", "candidate"),
            lane=d.get("lane", ""),
            steps=[],  # Steps reconstructed by SLICE handler
            sanitizer_chain=[],
            module_card_ids=d.get("module_card_ids", []),
            page_card_ids=d.get("page_card_ids", []),
            evidence=d.get("evidence", []),
            runtime_evidence=[],
            severity=d.get("severity", ""),
            cvss_score=d.get("cvss_score"),
            cwe_vuln=d.get("cwe_vuln"),
            discovered=d.get("discovered", ""),
            confirmed=d.get("confirmed", False),
            sources=d.get("sources", []),
        )
        if d.get("source"):
            try:
                card.source = FlowEndpoint(**d["source"])
            except (TypeError, KeyError):
                pass
        if d.get("sink"):
            try:
                card.sink = FlowEndpoint(**d["sink"])
            except (TypeError, KeyError):
                pass
        return card


def _to_dict(obj: Any, _seen: Optional[set] = None) -> Any:
    if obj is None:
        return None
    # Prevent infinite recursion with visited tracking
    if _seen is None:
        _seen = set()
    obj_id = id(obj)
    if obj_id in _seen:
        return None  # Already seen; avoid recursion
    _seen.add(obj_id)
    # Check dataclass FIRST (before hasattr to_dict, since dataclass instances have to_dict)
    if hasattr(obj, "__dataclass_fields__"):
        return {k: _to_dict(getattr(obj, k), _seen) for k in obj.__dataclass_fields__}
    if hasattr(obj, "to_dict") and callable(obj.to_dict):
        return obj.to_dict()
    if isinstance(obj, (list, tuple)):
        return [_to_dict(x, _seen) for x in obj]
    if isinstance(obj, dict):
        return {k: _to_dict(v, _seen) for k, v in obj.items()}
    return obj
