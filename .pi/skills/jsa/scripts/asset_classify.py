"""
jsa Skill — Asset classification (bundle detection)

Classifies each downloaded JavaScript file by type:
- single_component: One third-party library (e.g., jquery-1.9.0.min.js)
- multi_component_bundle: Multiple libraries bundled (e.g., vendor.js)
- first_party: Application code (e.g., app.js)
- inline: Inline script extracted from HTML
- cdn_bundle: CDN-hosted library
- unknown: Cannot determine

The classification drives correlation strength in the dedup/correlation
phase:
- single_component + cdn: full correlation (file → 1 component)
- first_party: reachability evidence (the strongest signal)
- multi_component_bundle: correlation downgraded without source map
- inline / unknown: weakest correlation

Why a separate module:
- Bundle detection requires looking at filename patterns, content headers,
  AND source map data — different from component ID reconciliation.
- This classification drives correlation scoring downstream, not dedup itself.
- Asset_classify runs in its own phase (or in cve_research_handler) to produce
  a file_classification map that all downstream phases can use.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Classification types
# ---------------------------------------------------------------------------

# File classification types
SINGLE_COMPONENT = "single_component"           # One third-party library file
MULTI_COMPONENT_BUNDLE = "multi_component_bundle"  # Multiple libraries bundled
FIRST_PARTY = "first_party"                       # Application-authored code
INLINE = "inline"                                 # Inline <script> block
CDN_BUNDLE = "cdn_bundle"                         # CDN-hosted library
UNKNOWN = "unknown"                               # Cannot determine

VALID_CLASSIFICATIONS = (
    SINGLE_COMPONENT,
    MULTI_COMPONENT_BUNDLE,
    FIRST_PARTY,
    INLINE,
    CDN_BUNDLE,
    UNKNOWN,
)


@dataclass
class ClassificationResult:
    """Result of classifying a single JS file."""
    file: str = ""
    classification: str = UNKNOWN
    confidence: str = "possible"        # "certain" | "probable" | "possible"
    components_detected: list[str] = field(default_factory=list)
    source_map_present: bool = False
    # Provenance: which signals contributed
    signals: list[str] = field(default_factory=list)
    # Reasoning
    reason: str = ""


# ---------------------------------------------------------------------------
# Heuristics
# ---------------------------------------------------------------------------

# Common bundler output patterns
_BUNDLE_PATTERNS = (
    "vendor", "vendors",
    "bundle", "bundles",
    "chunk", "chunks",
    "polyfill", "polyfills",
    "runtime", "commons",
    "app.min", "lib.min",
    "all.min", "libs",
)

# Common first-party app patterns
_FIRST_PARTY_PATTERNS = (
    "app", "main", "index", "site", "client",
    "components", "pages", "views", "modules",
    "router", "store", "utils", "helpers",
    "bootstrap", "config", "init",
    "app.js", "main.js", "index.js",
)

# Common library patterns (single third-party)
_LIBRARY_PATTERNS = (
    "jquery", "react", "vue", "angular", "lodash", "underscore",
    "moment", "dayjs", "date-fns", "axios", "d3", "three",
    "bootstrap", "tailwind", "materialize", "foundation",
    "chart", "chartjs", "highcharts",
    "backbone", "ember", "knockout", "meteor",
    "rxjs", "redux", "mobx", "graphql",
    "popper", "tooltip", "select2", "slick",
)

# CDN URL patterns
_CDN_PATTERNS = {
    "cdnjs": ("cdnjs.cloudflare.com", "/cdnjs/"),
    "jsdelivr": ("cdn.jsdelivr.net", "jsdelivr"),
    "unpkg": ("unpkg.com", "unpkg"),
}


def _is_inline(filename: str) -> bool:
    """Inline scripts use the _inline_ naming convention."""
    return "_inline_" in filename.lower()


def _is_cdn(filename: str, url: str = "") -> Optional[str]:
    """Detect if file is from a known CDN. Returns CDN name or None."""
    url_lower = url.lower()
    if not url_lower:
        return None
    for cdn_name, patterns in _CDN_PATTERNS.items():
        for pattern in patterns:
            if pattern in url_lower:
                return cdn_name
    return None


def _is_bundle_filename(filename: str) -> bool:
    """Check if filename suggests bundler output (vendor.js, chunk-X.js, etc.)."""
    fn_lower = filename.lower()
    return any(p in fn_lower for p in _BUNDLE_PATTERNS)


def _is_first_party_filename(filename: str) -> bool:
    """Check if filename matches common first-party app patterns."""
    fn_lower = filename.lower()
    if fn_lower in ("app.js", "main.js", "index.js"):
        return True
    return any(fn_lower.startswith(p + ".") or fn_lower == p + ".js" for p in _FIRST_PARTY_PATTERNS)


def _is_library_filename(filename: str) -> bool:
    """Check if filename matches a known library pattern."""
    fn_lower = filename.lower()
    return any(p in fn_lower for p in _LIBRARY_PATTERNS)


def _count_source_map_packages(source_map_sources: list[str]) -> int:
    """Count distinct node_modules/<pkg>/ references in source map sources."""
    if not source_map_sources:
        return 0
    import re
    pattern = re.compile(r"node_modules/(?:(@[^/]+/[^/]+)|([^/]+))/")
    packages = set()
    for src in source_map_sources:
        m = pattern.search(src)
        if m:
            packages.add(m.group(1) or m.group(2))
    return len(packages)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def classify_file(
    filename: str,
    content_head: str = "",
    url: str = "",
    source_map_sources: Optional[list[str]] = None,
    detection_details: Optional[list[dict]] = None,
) -> ClassificationResult:
    """
    Classify a single JS file.

    Args:
        filename: Local filename (e.g., "jquery-1.9.0.min.js")
        content_head: First ~64KB of file content (for banner detection)
        url: Source URL (used for CDN detection)
        source_map_sources: If source map is present, list of source paths
            (used to count distinct packages)
        detection_details: List of detection records for this file
            (from cve_research.detection_details). Each dict has:
            technology, vector, version, confidence.

    Returns:
        ClassificationResult with classification, confidence, components_detected,
        and reasoning.

    Classification priority:
    1. INLINE: filename contains "_inline_"
    2. CDN_BUNDLE: URL from known CDN
    3. SINGLE_COMPONENT: library filename pattern + (banner OR source map to one package)
    4. MULTI_COMPONENT_BUNDLE: bundle filename OR source map to 2+ packages
    5. FIRST_PARTY: app filename pattern + no library banners
    6. UNKNOWN: fall-through
    """
    source_map_sources = source_map_sources or []
    detection_details = detection_details or []
    components_detected = sorted({d.get("technology", "") for d in detection_details if d.get("technology")})

    # ── 1. INLINE: filename convention ──
    if _is_inline(filename):
        return ClassificationResult(
            file=filename,
            classification=INLINE,
            confidence="certain",
            components_detected=components_detected,
            source_map_present=bool(source_map_sources),
            signals=["filename_convention"],
            reason="Filename contains '_inline_' (extracted from HTML)",
        )

    # ── 2. CDN_BUNDLE: known CDN URL ──
    cdn = _is_cdn(filename, url)
    if cdn:
        return ClassificationResult(
            file=filename,
            classification=CDN_BUNDLE,
            confidence="certain",
            components_detected=components_detected,
            source_map_present=bool(source_map_sources),
            signals=["url_cdn_pattern"],
            reason=f"URL matches CDN pattern for {cdn}",
        )

    # ── 3. MULTI_COMPONENT_BUNDLE: source map to 2+ packages ──
    source_map_present = bool(source_map_sources)
    pkg_count = _count_source_map_packages(source_map_sources)
    if pkg_count >= 2:
        return ClassificationResult(
            file=filename,
            classification=MULTI_COMPONENT_BUNDLE,
            confidence="certain",
            components_detected=components_detected,
            source_map_present=source_map_present,
            signals=["source_map_multiple_packages"],
            reason=f"Source map references {pkg_count} distinct node_modules packages",
        )

    # ── 4. MULTI_COMPONENT_BUNDLE: bundle filename pattern ──
    is_bundle = _is_bundle_filename(filename)

    # ── 5. SINGLE_COMPONENT: library filename + (banner OR single source map package) ──
    is_library = _is_library_filename(filename)
    has_banner = bool(content_head and (
        content_head.startswith("/*!") or
        "/*! jQuery" in content_head[:500] or
        "/*! Bootstrap" in content_head[:500] or
        "/*\n * " in content_head[:500] or
        "@license" in content_head[:500]
    ))

    if is_library:
        if has_banner or pkg_count == 1:
            # Banner is highly reliable: it's a literal /*! jQuery v1.9.0 */ comment
            # Source map with single package is also reliable
            # Both signals together = maximum confidence, but either alone = certain
            if has_banner and pkg_count == 1:
                confidence = "certain"
            elif has_banner:
                confidence = "certain"  # Library banner is authoritative
            elif pkg_count == 1:
                confidence = "probable"  # Source map alone is good but not authoritative
            else:
                confidence = "probable"
            return ClassificationResult(
                file=filename,
                classification=SINGLE_COMPONENT,
                confidence=confidence,
                components_detected=components_detected,
                source_map_present=source_map_present,
                signals=["filename_library_pattern", "content_banner" if has_banner else "source_map_single_package"],
                reason=f"Library filename pattern with {'banner' if has_banner else 'single source map package'}",
            )
        # Library name but no confirming evidence — weaker
        if components_detected:
            return ClassificationResult(
                file=filename,
                classification=SINGLE_COMPONENT,
                confidence="possible",
                components_detected=components_detected,
                source_map_present=source_map_present,
                signals=["detector_match"],
                reason="Detector identified a library but no filename/banner confirmation",
            )

    # ── 6. FIRST_PARTY: app filename + no library indicators ──
    if _is_first_party_filename(filename) and not has_banner and not components_detected:
        return ClassificationResult(
            file=filename,
            classification=FIRST_PARTY,
            confidence="probable",
            components_detected=components_detected,
            source_map_present=source_map_present,
            signals=["filename_app_pattern"],
            reason="Filename matches first-party app pattern, no library indicators",
        )

    # ── 7. BUNDLE filename without confirming evidence ──
    if is_bundle and not components_detected:
        return ClassificationResult(
            file=filename,
            classification=MULTI_COMPONENT_BUNDLE,
            confidence="possible",
            components_detected=components_detected,
            source_map_present=source_map_present,
            signals=["filename_bundle_pattern"],
            reason="Bundle filename pattern, no source map or detector evidence",
        )

    # ── 8. UNKNOWN ──
    return ClassificationResult(
        file=filename,
        classification=UNKNOWN,
        confidence="possible",
        components_detected=components_detected,
        source_map_present=source_map_present,
        signals=[],
        reason="Insufficient evidence to classify",
    )


def classify_files(
    js_files: list[dict],
) -> dict[str, ClassificationResult]:
    """
    Classify multiple JS files.

    Args:
        js_files: list of dicts with keys:
            filename (str): local filename
            content_head (str, optional): first ~64KB of content
            url (str, optional): source URL
            source_map_sources (list, optional): source map source paths
            detection_details (list, optional): detection records for this file

    Returns:
        dict mapping filename → ClassificationResult
    """
    return {
        f.get("filename", ""): classify_file(
            filename=f.get("filename", ""),
            content_head=f.get("content_head", ""),
            url=f.get("url", ""),
            source_map_sources=f.get("source_map_sources"),
            detection_details=f.get("detection_details"),
        )
        for f in js_files
    }
