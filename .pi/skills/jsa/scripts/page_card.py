"""jsa Skill — PageCard dataclass

Represents one HTTP-interacted page in the target application.

PageCards are built by the STRUCTURE phase. Primary data sources:
- fingerprint_engine.py (technologies)
- asset_classify.py (classification)
- runtime_probe.py (runtime_versions)
- Caido HTTP history (via caido_* tools in Playwright proxy mode)
- Playwright network events (fallback if Caido unavailable)
- html_parser.py (script_files, dom_inventory)

Used by: page-DOM lane + network-behavior lane agents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class RequestSnapshot:
    """HTTP request captured from Caido or Playwright."""
    method: str = ""
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    body: Optional[str] = None
    parameters: dict[str, list[str]] = field(default_factory=dict)
    # Playwright resource type if from Playwright
    resource_type: str = ""
    # Source: "caido" | "playwright" | "acquire"
    source: str = ""

    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "url": self.url,
            "headers": dict(self.headers),
            "body": self.body,
            "parameters": dict(self.parameters),
            "resource_type": self.resource_type,
            "source": self.source,
        }


@dataclass
class ResponseSnapshot:
    """HTTP response captured from Caido or Playwright."""
    status_code: int = 0
    status_text: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    body: Optional[str] = None
    body_snippet: Optional[str] = None  # First N bytes for reference
    body_sha1: Optional[str] = None     # Hash for full body stored elsewhere
    mime_type: str = ""
    roundtrip_ms: int = 0
    source: str = ""

    def to_dict(self) -> dict:
        return {
            "status_code": self.status_code,
            "status_text": self.status_text,
            "headers": dict(self.headers),
            "body": self.body,
            "body_snippet": self.body_snippet,
            "body_sha1": self.body_sha1,
            "mime_type": self.mime_type,
            "roundtrip_ms": self.roundtrip_ms,
            "source": self.source,
        }


@dataclass
class ScriptFile:
    """A script file referenced from a page (parsed from HTML or Caido)."""
    filename: str = ""
    url: str = ""
    integrity: Optional[str] = None  # Subresource Integrity hash
    crossorigin: Optional[str] = None
    # Local file path if downloaded by ACQUIRE
    local_path: str = ""


@dataclass
class DOMInventory:
    """HTML structure inventory for page-DOM correlation."""
    # DOM IDs and names extracted from HTML
    dom_ids: list[str] = field(default_factory=list)
    form_actions: list[str] = field(default_factory=list)
    inline_event_handlers: list[str] = field(default_factory=list)  # onclick, onsubmit, etc.
    iframe_srcs: list[str] = field(default_factory=list)
    csp_header: Optional[str] = None
    # Meta tags relevant to security
    meta_tags: dict[str, str] = field(default_factory=dict)


@dataclass
class WAFAlert:
    """WAF rule match (Coraza/CRS-style). For future use."""
    rule_id: int = 0
    severity: str = ""  # "CRITICAL" | "ERROR" | "WARNING" | "NOTICE"
    message: str = ""
    match_data: str = ""


@dataclass
class PageCard:
    """One HTTP-interacted page.

    page_id is a UUID generated at build time. All cross-references
    (FlowCard.page_card_ids) use this ID.
    """
    page_id: str = ""
    url: str = ""
    method: str = "GET"
    timestamp: str = ""

    request: Optional[RequestSnapshot] = None
    response: Optional[ResponseSnapshot] = None

    # Technologies (from fingerprint_engine)
    technologies: list[Any] = field(default_factory=list)  # list[TechDetection]
    # Runtime probe results (from runtime_probe)
    runtime_versions: list[Any] = field(default_factory=list)  # list[RuntimeProbeResult]
    # File classification (from asset_classify)
    classification: Optional[Any] = None  # ClassificationResult

    # WAF alerts (future)
    waf_alerts: list[WAFAlert] = field(default_factory=list)

    # Script files loaded by this page
    script_files: list[ScriptFile] = field(default_factory=list)

    # DOM structure
    dom_inventory: Optional[DOMInventory] = None

    # Provenance: where did this data come from?
    # Comma-separated list of sources: "caido,playwright,acquire,fingerprint,probe"
    sources: list[str] = field(default_factory=list)

    # If Caido was unavailable for this page
    http_history_unavailable: bool = False

    def to_dict(self) -> dict:
        """Serialize to JSON-compatible dict for MemPalace storage."""
        return {
            "page_id": self.page_id,
            "url": self.url,
            "method": self.method,
            "timestamp": self.timestamp,
            "request": _to_dict(self.request),
            "response": _to_dict(self.response),
            "technologies": [_to_dict(t) for t in self.technologies],
            "runtime_versions": [_to_dict(r) for r in self.runtime_versions],
            "classification": _to_dict(self.classification),
            "waf_alerts": [_to_dict(w) for w in self.waf_alerts],
            "script_files": [_to_dict(s) for s in self.script_files],
            "dom_inventory": _to_dict(self.dom_inventory),
            "sources": self.sources,
            "http_history_unavailable": self.http_history_unavailable,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "PageCard":
        """Deserialize from dict (for resume/state restore)."""
        card = cls(
            page_id=d.get("page_id", ""),
            url=d.get("url", ""),
            method=d.get("method", "GET"),
            timestamp=d.get("timestamp", ""),
            sources=d.get("sources", []),
            http_history_unavailable=d.get("http_history_unavailable", False),
        )
        if d.get("request"):
            card.request = RequestSnapshot(**d["request"])
        if d.get("response"):
            card.response = ResponseSnapshot(**d["response"])
        if d.get("dom_inventory"):
            card.dom_inventory = DOMInventory(**d["dom_inventory"])
        return card


def _to_dict(obj: Any, _seen: Optional[set] = None) -> Any:
    """Recursively convert dataclasses to dicts.

    Uses visited tracking to prevent infinite recursion.
    """
    if obj is None:
        return None
    if _seen is None:
        _seen = set()
    obj_id = id(obj)
    if obj_id in _seen:
        return None  # Already seen; avoid recursion
    _seen.add(obj_id)
    # Dataclass first to avoid recursion via to_dict method
    if hasattr(obj, "__dataclass_fields__"):
        return {k: _to_dict(getattr(obj, k), _seen) for k in obj.__dataclass_fields__}
    if hasattr(obj, "to_dict") and callable(obj.to_dict):
        return obj.to_dict()
    if isinstance(obj, (list, tuple)):
        return [_to_dict(x, _seen) for x in obj]
    if isinstance(obj, dict):
        return {k: _to_dict(v, _seen) for k, v in obj.items()}
    return obj
