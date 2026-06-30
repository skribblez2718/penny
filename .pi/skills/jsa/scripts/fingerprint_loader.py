"""
fingerprint_loader.py — Wappalyzer Fingerprint Database Loader

Parses technologies.json (vendored from wapalyzer-core v6.11.0) into an
efficient in-memory structure for offline regex matching against downloaded
JS/HTML files.

Usage:
    from fingerprint_loader import load_fingerprints, FingerprintDB

    db = load_fingerprints()  # loads from assets/technologies.json
    print(f"Loaded {len(db.technologies)} technologies")
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class FingerprintPattern:
    """A compiled fingerprint pattern for one detection vector."""
    technology: str           # Technology name (e.g., "jQuery")
    vector: str               # Detection vector: scriptSrc, scripts, html, js
    pattern_raw: str          # Raw pattern string from technologies.json
    regex: re.Pattern         # Compiled regex
    version_group: int = 0    # Capture group index for version (0 = no version)
    confidence: int = 100     # Confidence score (0–100)


@dataclass
class FingerprintDB:
    """Loaded fingerprint database."""
    version: str                                    # DB version (e.g., "6.11.0")
    technologies: dict[str, dict]                   # Raw tech entries
    scriptsrc_patterns: list[FingerprintPattern] = field(default_factory=list)
    content_patterns: list[FingerprintPattern] = field(default_factory=list)   # scripts + html
    name_aliases: dict[str, str] = field(default_factory=dict)  # alias → canonical
    stats: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Pattern parsing
# ---------------------------------------------------------------------------

# Annotation syntax: "pattern\\;version:\\1\\;confidence:50"
_ANNOTATION_RE = re.compile(r"(.*?)(?:\\;((?:version|confidence):[^\\;]*(?:\\;(?:version|confidence):[^\\;]*)*))?$")


def parse_pattern(raw: str) -> tuple[str, int, int]:
    """Parse a Wappalyzer pattern string with annotations.

    Format: "regex_pattern\;version:\1\;confidence:50"

    After JSON decoding, the annotation separator is a literal backslash-semicolon
    and backreferences like \1 are literal two-character sequences.

    Returns:
        (clean_regex, version_group, confidence)
        - version_group: 0 = no version extraction, ≥1 = capture group index
        - confidence: 0–100, defaults to 100
    """
    import re as _re

    version_group = 0
    confidence = 100
    clean = raw

    # Find annotation separator (literal backslash-semicolon)
    anno_start = raw.find("\;")
    if anno_start != -1:
        clean = raw[:anno_start]
        annotations = raw[anno_start + 2:]  # skip "\;"

        # Extract version group: handles both "version:\1" and "version:1"
        ver_match = _re.search(r"version:\\?(\d+)", annotations)
        if ver_match:
            try:
                version_group = int(ver_match.group(1))
            except (ValueError, IndexError):
                version_group = 0

        # Extract confidence: "confidence:50"
        conf_match = _re.search(r"confidence:(\d+)", annotations)
        if conf_match:
            try:
                confidence = int(conf_match.group(1))
            except (ValueError, IndexError):
                confidence = 100

    return clean, version_group, confidence


def _compile_safe(pattern: str) -> Optional[re.Pattern]:
    """Compile a regex pattern, returning None on failure."""
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None


# ---------------------------------------------------------------------------
# Database loading
# ---------------------------------------------------------------------------


def load_fingerprints(db_path: Optional[Path] = None) -> FingerprintDB:
    """Load and parse the Wappalyzer fingerprint database.

    Args:
        db_path: Path to technologies.json. Defaults to the vendored copy
                 in .pi/skills/jsa/assets/technologies.json.

    Returns:
        FingerprintDB with compiled patterns ready for matching.

    Raises:
        FileNotFoundError: If technologies.json cannot be found.
        json.JSONDecodeError: If the file is not valid JSON.
    """
    if db_path is None:
        # Resolve relative to this file's location
        db_path = Path(__file__).resolve().parent.parent / "assets" / "technologies.json"

    if not db_path.exists():
        raise FileNotFoundError(
            f"Fingerprint database not found at {db_path}. "
            "Run update_fingerprints.py to download."
        )

    with open(db_path, "r", encoding="utf-8") as f:
        raw: dict[str, Any] = json.load(f)

    # Extract database metadata
    categories = raw.get("categories", {})
    technologies = {k: v for k, v in raw.items() if k != "categories"}

    db = FingerprintDB(
        version="6.11.0",
        technologies=technologies,
    )

    # Phase 1 vectors that work offline on downloaded files:
    #   scriptSrc — filename/URL patterns (matched against filenames)
    #   scripts   — inline script content patterns
    #   html      — HTML content/comment patterns
    #
    # Phase 2 (deferred): js — JavaScript global patterns (runtime-dependent)

    for name, tech in technologies.items():
        # ── scriptSrc patterns ──
        scriptsrc = tech.get("scriptSrc")
        if scriptsrc:
            entries = _to_list(scriptsrc)
            for raw_pattern in entries:
                if not isinstance(raw_pattern, str):
                    continue
                clean, vgroup, conf = parse_pattern(raw_pattern)
                cregex = _compile_safe(clean)
                if cregex:
                    db.scriptsrc_patterns.append(FingerprintPattern(
                        technology=name,
                        vector="scriptSrc",
                        pattern_raw=raw_pattern,
                        regex=cregex,
                        version_group=vgroup,
                        confidence=conf,
                    ))

        # ── scripts patterns (inline script content) ──
        scripts = tech.get("scripts")
        if scripts:
            entries = _to_list(scripts)
            for raw_pattern in entries:
                if not isinstance(raw_pattern, str):
                    continue
                clean, vgroup, conf = parse_pattern(raw_pattern)
                cregex = _compile_safe(clean)
                if cregex:
                    db.content_patterns.append(FingerprintPattern(
                        technology=name,
                        vector="scripts",
                        pattern_raw=raw_pattern,
                        regex=cregex,
                        version_group=vgroup,
                        confidence=conf,
                    ))

        # ── html patterns ──
        html = tech.get("html")
        if html:
            entries = _to_list(html)
            for raw_pattern in entries:
                if not isinstance(raw_pattern, str):
                    continue
                clean, vgroup, conf = parse_pattern(raw_pattern)
                cregex = _compile_safe(clean)
                if cregex:
                    db.content_patterns.append(FingerprintPattern(
                        technology=name,
                        vector="html",
                        pattern_raw=raw_pattern,
                        regex=cregex,
                        version_group=vgroup,
                        confidence=conf,
                    ))

    # ── Build name aliases ──
    # Lowercase canonical names for fuzzy matching
    for name in technologies:
        db.name_aliases[name.lower()] = name
        # Common variations
        if name.endswith(".js"):
            db.name_aliases[name.lower().replace(".js", "")] = name

    # ── Stats ──
    db.stats = {
        "total_technologies": len(technologies),
        "scriptsrc_patterns": len(db.scriptsrc_patterns),
        "content_patterns": len(db.content_patterns),
        "technologies_with_scriptsrc": sum(1 for t in technologies.values() if t.get("scriptSrc")),
        "technologies_with_scripts": sum(1 for t in technologies.values() if t.get("scripts")),
        "technologies_with_html": sum(1 for t in technologies.values() if t.get("html")),
        "categories": len(categories),
    }

    return db


def _to_list(value: Any) -> list:
    """Normalize a string or list to a list."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return value
    return []


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    db = load_fingerprints()
    print(f"Loaded {db.stats['total_technologies']} technologies")
    print(f"  scriptSrc patterns: {db.stats['scriptsrc_patterns']}")
    print(f"  content patterns:   {db.stats['content_patterns']}")
    print(f"  aliases:            {len(db.name_aliases)}")

    # Show a few examples
    for p in db.scriptsrc_patterns[:3]:
        ver = f" (version group {p.version_group})" if p.version_group else ""
        print(f"  [{p.vector}] {p.technology}: {p.pattern_raw[:60]}{ver}")
    for p in db.content_patterns[:3]:
        ver = f" (version group {p.version_group})" if p.version_group else ""
        print(f"  [{p.vector}] {p.technology}: {p.pattern_raw[:60]}{ver}")
