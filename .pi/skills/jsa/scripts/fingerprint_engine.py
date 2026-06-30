"""
fingerprint_engine.py — Wappalyzer Fingerprint Detection Engine

Applies loaded fingerprint patterns to downloaded JS/HTML filenames and
file content. Phase 1 vectors: scriptSrc (filename/URL matching),
scripts (inline script content), html (HTML content/comments).

Phase 2 (deferred, gated on benchmark): js (JavaScript globals, runtime-heavy).

Usage:
    from fingerprint_loader import load_fingerprints
    from fingerprint_engine import FingerprintEngine

    db = load_fingerprints()
    engine = FingerprintEngine(db)

    # Detect from filename
    detections = engine.detect_from_filename("jquery-3.7.1.min.js")

    # Detect from file content
    detections = engine.detect_from_content(file_content, "app.js")
"""

import re
from dataclasses import dataclass, field
from typing import Optional

from fingerprint_loader import FingerprintDB, FingerprintPattern


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class TechDetection:
    """Result of a single technology detection."""
    name: str                          # Canonical technology name
    confidence: int                    # 0–100
    version: Optional[str] = None      # Extracted version string, if any
    vector: str = ""                   # Detection vector (scriptSrc, scripts, html)
    evidence: str = ""                 # What triggered the match


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class FingerprintEngine:
    """Applies Wappalyzer fingerprint patterns to detect technologies."""

    def __init__(self, db: FingerprintDB):
        self.db = db

    # ── Filename detection (scriptSrc vector) ──

    def detect_from_filename(self, filename: str) -> list[TechDetection]:
        """Detect technologies from a JS filename or URL path.

        Matches against both the bare filename and a simulated URL path
        (prepended with /) to support Wappalyzer patterns that expect
        URL-like paths (e.g., "/jquery-3.7.1/jquery.min.js").

        Args:
            filename: The filename or URL path (e.g., "jquery-3.7.1.min.js"
                      or "/assets/js/react-18.2.0.production.min.js").

        Returns:
            List of TechDetection sorted by confidence (highest first),
            deduplicated by technology name.
        """
        detections: dict[str, TechDetection] = {}

        # Build search targets: bare filename + simulated URL path.
        # Wappalyzer scriptSrc patterns often expect URL-like paths.
        targets = [filename]
        if not filename.startswith("/"):
            targets.append("/" + filename)

        for target in targets:
            for pattern in self.db.scriptsrc_patterns:
                match = pattern.regex.search(target)
                if not match:
                    continue

                name = pattern.technology
                conf = pattern.confidence
                version = None

                if pattern.version_group > 0 and pattern.version_group <= (match.lastindex or 0):
                    version = match.group(pattern.version_group)

                # Keep highest-confidence detection per technology.
                # When confidence ties, prefer the detection WITH a version.
                if name not in detections:
                    detections[name] = TechDetection(
                        name=name, confidence=conf, version=version,
                        vector="scriptSrc",
                        evidence=f"filename match: {pattern.pattern_raw[:80]}",
                    )
                elif conf > detections[name].confidence:
                    detections[name] = TechDetection(
                        name=name, confidence=conf, version=version,
                        vector="scriptSrc",
                        evidence=f"filename match: {pattern.pattern_raw[:80]}",
                    )
                elif conf == detections[name].confidence and version and not detections[name].version:
                    # Tie-breaking: prefer versioned detection
                    detections[name] = TechDetection(
                        name=name, confidence=conf, version=version,
                        vector="scriptSrc",
                        evidence=f"filename match: {pattern.pattern_raw[:80]}",
                    )

        return sorted(detections.values(), key=lambda d: d.confidence, reverse=True)

    # ── Content detection (scripts + html vectors) ──

    def detect_from_content(self, content: str, filename: str = "") -> list[TechDetection]:
        """Detect technologies from file content (first 16KB recommended).

        Args:
            content: File content text to scan.
            filename: Optional filename for context (not used in matching).

        Returns:
            List of TechDetection sorted by confidence, deduplicated.
        """
        detections: dict[str, TechDetection] = {}

        # Scan first 64KB (generous for version comments deep in bundles)
        scan_text = content[:65536]

        for pattern in self.db.content_patterns:
            match = pattern.regex.search(scan_text)
            if not match:
                continue

            name = pattern.technology
            conf = pattern.confidence
            version = None

            if pattern.version_group > 0 and pattern.version_group <= match.lastindex:
                version = match.group(pattern.version_group)

            if name not in detections:
                detections[name] = TechDetection(
                    name=name,
                    confidence=conf,
                    version=version,
                    vector=pattern.vector,
                    evidence=f"{pattern.vector} match: {pattern.pattern_raw[:80]}",
                )
            elif conf > detections[name].confidence:
                detections[name] = TechDetection(
                    name=name,
                    confidence=conf,
                    version=version,
                    vector=pattern.vector,
                    evidence=f"{pattern.vector} match: {pattern.pattern_raw[:80]}",
                )
            elif conf == detections[name].confidence and version and not detections[name].version:
                detections[name] = TechDetection(
                    name=name,
                    confidence=conf,
                    version=version,
                    vector=pattern.vector,
                    evidence=f"{pattern.vector} match: {pattern.pattern_raw[:80]}",
                )

        return sorted(detections.values(), key=lambda d: d.confidence, reverse=True)

    # ── Combined detection ──

    def detect(self, filename: str, content: str = "") -> list[TechDetection]:
        """Run all detection vectors and merge results.

        Args:
            filename: JS filename or path.
            content: File content (empty = filename-only detection).

        Returns:
            Merged, deduplicated, confidence-sorted detections.
        """
        merged: dict[str, TechDetection] = {}

        for det in self.detect_from_filename(filename):
            merged[det.name] = det

        if content:
            for det in self.detect_from_content(content, filename):
                if det.name not in merged or det.confidence > merged[det.name].confidence:
                    merged[det.name] = det

        return sorted(merged.values(), key=lambda d: d.confidence, reverse=True)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    from fingerprint_loader import load_fingerprints

    db = load_fingerprints()
    engine = FingerprintEngine(db)

    # Test 1: jQuery filename
    print("=== jQuery filename ===")
    for d in engine.detect_from_filename("jquery-3.7.1.min.js"):
        print(f"  {d.name} v{d.version} (conf={d.confidence}, {d.vector})")

    # Test 2: React filename
    print("=== React filename ===")
    for d in engine.detect_from_filename("react-18.2.0.production.min.js"):
        print(f"  {d.name} v{d.version} (conf={d.confidence}, {d.vector})")

    # Test 3: jQuery content
    print("=== jQuery content ===")
    jq_content = """
    /*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */
    !function(e,t){"use strict";"object"==typeof module...
    """
    for d in engine.detect_from_content(jq_content):
        print(f"  {d.name} v{d.version} (conf={d.confidence}, {d.vector})")

    # Test 4: Vue content
    print("=== Vue content ===")
    vue_content = """
    /*!
    * Vue.js v3.4.21
    * (c) 2014-2024 Evan You
    * Released under the MIT License.
    */
    """
    for d in engine.detect_from_content(vue_content):
        print(f"  {d.name} v{d.version} (conf={d.confidence}, {d.vector})")

    # Test 5: No detection
    print("=== Unknown file ===")
    dets = engine.detect("app.js", "function init() { console.log('hello'); }")
    print(f"  Detections: {len(dets)} (expected 0)")
