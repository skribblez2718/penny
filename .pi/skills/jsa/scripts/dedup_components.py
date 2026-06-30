"""
jsa Skill — Component normalization and deduplication

Reconciles evidence from multiple detectors (Wappalyzer, source maps, content
regex, runtime probes) into a single canonical Component record per detected
library. Uses purl (Package URL) as the stable identifier.

Why a separate module:
- Component identity reconciliation is fundamentally different from
  vulnerability alias canonicalization or SAST fingerprint deduplication.
- The three operations have different inputs, different outputs, and
  different edge cases. Splitting them makes each easier to test and evolve.

This module was created as part of Priority 2 (split dedup.py into
targeted modules). It does NOT yet correlate to CVEs or SAST findings — that
happens in correlate_evidence.py after NORMALIZE and DEDUP_WITHIN_SOURCE.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Component dataclass
# ---------------------------------------------------------------------------

@dataclass
class Component:
    """Canonical component record produced by component normalization.

    Uses purl as the stable identifier. Files, pages, and detection evidence
    are aggregated from all detectors. detection_confidence reflects agreement
    across sources.
    """
    purl: str = ""                         # e.g., "pkg:npm/jquery@1.9.0"
    bom_ref: str = ""                      # future: SBOM reference
    ecosystem: str = ""                    # npm, cdnjs, jsdelivr, unpkg, github, generic
    name: str = ""                         # lowercased npm-style name (e.g., "jquery")
    display_name: str = ""                 # human-readable (e.g., "jQuery")
    version: Optional[str] = None
    files: list[str] = field(default_factory=list)              # local file paths
    loaded_on_pages: list[str] = field(default_factory=list)    # pages where loaded
    detection_confidence: str = "possible"  # "certain" | "probable" | "possible"
    detection_evidence: list[dict] = field(default_factory=list)
    # provenance: which detectors contributed evidence
    detectors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def _derive_ecosystem_from_purl(purl: str) -> str:
    """Extract ecosystem from a purl string.

    For cdn URLs, the provider (cdnjs/jsdelivr/unpkg) is the ecosystem.
    """
    if not purl or not purl.startswith("pkg:"):
        return ""
    rest = purl[4:]
    # For cdn: pkg:cdn/<provider>/<name>
    if rest.startswith("cdn/"):
        parts = rest.split("/", 2)
        if len(parts) >= 2:
            return parts[1]  # cdnjs, jsdelivr, unpkg
    # For github: pkg:github/<owner>/<name>
    if rest.startswith("github/"):
        return "github"
    # For npm: pkg:npm/<name>
    if rest.startswith("npm/"):
        return "npm"
    # For generic
    if rest.startswith("generic/"):
        return "generic"
    return ""


def _derive_name_from_purl(purl: str) -> str:
    """Extract name from a purl string (decoding %40 → @ for npm scopes)."""
    if not purl or not purl.startswith("pkg:"):
        return ""
    rest = purl[4:]
    # Strip ecosystem prefix
    if rest.startswith("cdn/"):
        parts = rest.split("/", 2)
        if len(parts) >= 3:
            return parts[2]  # name (last segment)
        return ""
    if rest.startswith("github/"):
        parts = rest.split("/", 2)
        if len(parts) >= 3:
            return parts[2]
        return ""
    if rest.startswith(("npm/", "generic/")):
        parts = rest.split("/", 1)
        if len(parts) >= 2:
            return parts[1]
        return ""
    return ""


# ---------------------------------------------------------------------------
# Confidence promotion logic
# ---------------------------------------------------------------------------

def _derive_confidence(detection_evidence: list[dict]) -> str:
    """Derive overall detection confidence from multiple evidence sources.

    Rules:
    - Wappalyzer + source map (or content regex) + version: "certain"
    - Wappalyzer + version: "probable"
    - Wappalyzer only, or single source with version: "probable"
    - Single source, no version: "possible"

    Evidence dicts may contain: source ("wappalyzer", "source_map",
    "content", "runtime_probe"), has_version (bool), file.
    """
    sources = {e.get("source") for e in detection_evidence}
    has_version = any(e.get("has_version") for e in detection_evidence)

    # Multi-source agreement + version = certain
    if len(sources - {None}) >= 2 and has_version:
        return "certain"

    # Single source with version = probable
    if has_version:
        return "probable"

    # Single source without version = possible
    return "possible"


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def dedup_components(
    tech_stack_hints: dict[str, list[str]],
    versions: dict[str, str],
    component_purls: dict[str, str],
    detection_details: list[dict],
    loaded_on_pages: Optional[dict[str, list[str]]] = None,
) -> list[Component]:
    """
    Reconcile component detection from multiple sources into canonical records.

    Args:
        tech_stack_hints: Wappalyzer canonical name → list of files.
            Example: {"jQuery": ["jquery-1.9.0.min.js"]}
        versions: Wappalyzer canonical name → version.
            Example: {"jQuery": "1.9.0"}
        component_purls: Wappalyzer canonical name → purl (from cve_research).
            Example: {"jQuery": "pkg:npm/jquery@1.9.0"}
        detection_details: List of detection detail dicts from
            cve_research.detection_details. Each dict has keys:
            technology, file, vector, confidence, version, evidence.
        loaded_on_pages: Optional Wappalyzer canonical name → list of pages
            where this component was loaded (from ACQUIRE runtime probes).
            Example: {"jQuery": ["/account", "/checkout"]}

    Returns:
        List of Component records, one per detected library.
    """
    components: dict[str, Component] = {}

    # Pass 1: build evidence buckets per Wappalyzer name
    evidence_by_lib: dict[str, list[dict]] = {}
    for det in detection_details:
        lib = det.get("technology", "")
        if not lib:
            continue
        evidence_by_lib.setdefault(lib, []).append({
            "source": det.get("vector", "unknown"),  # vector: scriptSrc, sourceMap, content
            "file": det.get("file", ""),
            "has_version": bool(det.get("version")),
            "confidence": det.get("confidence", ""),
            "evidence": det.get("evidence", ""),
        })

    # Pass 2: for each detected library, build a Component
    for lib_name, files in tech_stack_hints.items():
        purl = component_purls.get(lib_name, "")
        if not purl:
            # Skip libraries without purl — they can't be normalized
            continue

        version = versions.get(lib_name)
        ecosystem = _derive_ecosystem_from_purl(purl)
        name = _derive_name_from_purl(purl)

        evidence = evidence_by_lib.get(lib_name, [])

        # Deduplicate files (preserve order)
        unique_files = list(dict.fromkeys(files))

        # Get loaded pages if available
        pages = []
        if loaded_on_pages:
            pages = loaded_on_pages.get(lib_name, [])

        # Derive overall confidence
        confidence = _derive_confidence(evidence)

        # Get unique detector names
        detectors = sorted({e.get("source", "unknown") for e in evidence if e.get("source")})

        components[lib_name] = Component(
            purl=purl,
            bom_ref=f"component:{name}:{version or 'unknown'}",
            ecosystem=ecosystem,
            name=name,
            display_name=lib_name,
            version=version,
            files=unique_files,
            loaded_on_pages=pages,
            detection_confidence=confidence,
            detection_evidence=evidence,
            detectors=detectors,
        )

    return list(components.values())


def components_to_dicts(components: list[Component]) -> list[dict]:
    """Serialize components to dicts for state metadata storage."""
    return [
        {
            "purl": c.purl,
            "bom_ref": c.bom_ref,
            "ecosystem": c.ecosystem,
            "name": c.name,
            "display_name": c.display_name,
            "version": c.version,
            "files": c.files,
            "loaded_on_pages": c.loaded_on_pages,
            "detection_confidence": c.detection_confidence,
            "detection_evidence": c.detection_evidence,
            "detectors": c.detectors,
        }
        for c in components
    ]
