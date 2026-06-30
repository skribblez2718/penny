"""jsa Skill — ModuleCard dataclass

Represents one JS/HTML/asset file in the target's static corpus.

ModuleCards are built by the STRUCTURE phase. Primary data sources:
- fingerprint_engine.py (detections)
- asset_classify.py (classification)
- runtime_probe.py (if applicable)
- splitter.py AST index (dangerous patterns)

Used by: code-static lane agents (cross-referenced from FlowCard).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class DangerousPattern:
    """A potentially-vulnerable pattern detected via tree-sitter query."""
    pattern_id: str = ""
    description: str = ""
    line: int = 0
    column: int = 0
    code_snippet: str = ""
    severity: str = "info"  # "info" | "low" | "medium" | "high" | "critical"
    cwe_id: Optional[str] = None
    # Vulnerability classes this pattern suggests
    suggested_vuln_classes: list[str] = field(default_factory=list)


@dataclass
class ASTSummary:
    """Compact summary of a parsed AST (tree-sitter)."""
    # Counts by node type
    function_count: int = 0
    class_count: int = 0
    arrow_function_count: int = 0
    call_count: int = 0
    identifier_count: int = 0

    # Import/export edges (for module relationship map)
    imports: list[str] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)

    # Top-level function/class names
    top_level_names: list[str] = field(default_factory=list)

    # Parse quality
    parse_errors: int = 0
    parse_error_rate: float = 0.0  # 0.0 = clean, 1.0 = all errors


@dataclass
class ModuleCard:
    """One JS/HTML/asset file in the target's corpus."""
    filename: str = ""
    url: Optional[str] = None
    # Foreign keys: which PageCards load this file
    page_card_ids: list[str] = field(default_factory=list)

    source_length: int = 0
    hash: str = ""  # SHA1 of file content
    source_map_url: Optional[str] = None

    # File classification (from asset_classify)
    classification: Optional[Any] = None  # ClassificationResult

    # Technology detections (from fingerprint_engine)
    detections: list[Any] = field(default_factory=list)  # list[TechDetection]

    # Compact AST summary
    ast_summary: Optional[ASTSummary] = None

    # Dangerous patterns (from tree-sitter queries)
    dangerous_patterns: list[DangerousPattern] = field(default_factory=list)

    # Joern data flow slices (populated by SLICE phase)
    data_flow_slices: list[Any] = field(default_factory=list)  # list[DataFlowSlice]

    # Provenance
    sources: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return _to_dict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ModuleCard":
        card = cls(
            filename=d.get("filename", ""),
            url=d.get("url"),
            page_card_ids=d.get("page_card_ids", []),
            source_length=d.get("source_length", 0),
            hash=d.get("hash", ""),
            source_map_url=d.get("source_map_url"),
            detections=d.get("detections", []),
            data_flow_slices=d.get("data_flow_slices", []),
            sources=d.get("sources", []),
        )
        if d.get("classification"):
            try:
                card.classification = _from_dict_any(d["classification"])
            except (TypeError, KeyError):
                pass
        if d.get("ast_summary"):
            try:
                card.ast_summary = ASTSummary(**d["ast_summary"])
            except (TypeError, KeyError):
                pass
        return card


def _to_dict(obj: Any, _seen: Optional[set] = None) -> Any:
    if obj is None:
        return None
    if _seen is None:
        _seen = set()
    obj_id = id(obj)
    if obj_id in _seen:
        return None
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


def _from_dict_any(d: dict) -> Any:
    """Best-effort reconstruct a dataclass from a dict by matching fields."""
    # Used for ClassificationResult and other upstream dataclasses.
    # We just return the dict and let the consumer use it.
    return d
