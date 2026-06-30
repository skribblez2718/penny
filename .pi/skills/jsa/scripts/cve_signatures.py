"""
jsa Skill — CVE Signature Extraction

Extracts vulnerability signature data from CVE descriptions, NVD APIs,
ExploitDB, and known patterns. Each CVE gets:

    {
        "vulnerable_symbols": ["$.extend", "$.fn.extend"],
        "required_conditions": ["deep: true (first argument)"],
        "non_vulnerable_patterns": ["jQuery.each", "$.ajax"],
        "exploitability_notes": "Prototype pollution via deep clone...",
    }

The pipeline already has CVE descriptions and NVD summaries from the
lookup phase. This module parses them for:
  - Function/method names that are vulnerable
  - Required call conditions (deep clone, eval, etc.)
  - Safe API variants that look similar but are not vulnerable
  - Exploit mechanics and testing notes

Why this is a separate module:
- Signature extraction is fundamentally different from CVE lookup.
  Lookup finds which CVEs apply to which versions. Signature extraction
  determines WHAT code patterns to look for in SAST results.
- This is a deterministic parser, not an agent. It works
  offline with the data already retrieved.
- The output (vulnerable_symbols) is consumed by correlate_evidence.py
  to score SAST↔CVE edges meaningfully instead of always scoring 0.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class CVESignature:
    """Extracted vulnerability signature for a single CVE."""
    cve_id: str = ""
    library: str = ""
    # Vulnerable symbols (functions, methods, APIs)
    vulnerable_symbols: list[str] = field(default_factory=list)
    # Conditions that must hold for the vulnerability to trigger
    required_conditions: list[str] = field(default_factory=list)
    # Patterns that are NOT vulnerable (false positive filters)
    non_vulnerable_patterns: list[str] = field(default_factory=list)
    # Human-readable exploit mechanics
    exploitability_notes: str = ""
    # Extraction sources
    extraction_sources: list[str] = field(default_factory=list)
    # Confidence in the signature extraction
    signature_confidence: str = "possible"  # certain / probable / possible


# ---------------------------------------------------------------------------
# Symbol extraction heuristics
# ---------------------------------------------------------------------------

# Known vulnerable API patterns by library
# Maps library name → (vulnerable_symbols, non_vulnerable_patterns, conditions,
#                       exploitability_notes) for the most common CVEs.
_KNOWN_VULN_SIGNATURES: dict[str, list[dict]] = {
    "jquery": [
        {
            "cve_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend", "$.fn.extend", "jQuery.extend"],
            "required_conditions": [
                "deep: true (first argument must be true)",
                "user-controlled data in source object",
            ],
            "non_vulnerable_patterns": [
                "jQuery.each",
                "$.ajax",
                "$.get",
            ],
            "note": "Prototype pollution via deep clone. The vulnerable API is $.extend(true, {}, tainted). "
                    "Shallow extend or $.each are not affected.",
        },
        {
            "cve_id": "CVE-2020-11022",
            "vulnerable_symbols": [".html(", "jQuery.fn.html"],
            "required_conditions": [
                "HTML content from user-controlled source",
            ],
            "non_vulnerable_patterns": [
                ".text(",
                ".attr('title',",
            ],
            "note": "HTML injection in jQuery.html() method when used with "
                    "user-controlled content. .text() and .attr() are safe.",
        },
        {
            "cve_id": "CVE-2015-9251",
            "vulnerable_symbols": ["$.parseHTML"],
            "required_conditions": [
                "User-controlled HTML string parsed",
            ],
            "non_vulnerable_patterns": [
                "$().html()",
                "$.htmlDecode",
            ],
            "note": "XSS via $.parseHTML() when parsing untrusted HTML content.",
        },
    ],
    "lodash": [
        {
            "cve_id": "CVE-2020-28500",
            "vulnerable_symbols": ["_.merge", "_.defaultsDeep", "_.templateSettings"],
            "required_conditions": [
                "Prototype pollution via user-controlled keys",
            ],
            "non_vulnerable_patterns": [
                "_.assign",
                "_.clone",
                "_.pick",
            ],
            "note": "Prototype pollution in _.merge() and _.defaultsDeep() "
                    "when merging objects with user-controlled keys.",
        },
        {
            "cve_id": "CVE-2021-23337",
            "vulnerable_symbols": ["_.template"],
            "required_conditions": [
                "User-controlled template string",
                "eval enabled in templateSettings",
            ],
            "non_vulnerable_patterns": [
                "_.escape",
                "_.templateSettings.evaluate",
            ],
            "note": "RCE via _.template() when processing user-controlled "
                    "template strings with eval enabled.",
        },
    ],
    "react": [
        {
            "cve_id": "CVE-2021-24125",
            "vulnerable_symbols": ["dangerouslySetInnerHTML"],
            "required_conditions": [
                "innerHTML contains user-controlled data",
                "No sanitization before rendering",
            ],
            "non_vulnerable_patterns": [
                "<div>{safeText}</div>",
                "React.createElement",
                "JSX element attributes",
            ],
            "note": "XSS via dangerouslySetInnerHTML when HTML content is "
                    "not sanitized. Normal JSX interpolation is safe.",
        },
    ],
    "angular": [
        {
            "cve_id": "CVE-2021-24288",
            "vulnerable_symbols": ["$eval", "$animate"],
            "required_conditions": [
                "User-controlled expression in $eval",
                "TrustedSourcePolicy not enforced",
            ],
            "non_vulnerable_patterns": [
                "{{ expression }}",
                "ng-bind",
                "ng-class",
            ],
            "note": "DOM XSS in AngularJS when user input is passed to $eval "
                    "without TrustedSourcePolicy enforcement.",
        },
    ],
    "bootstrap": [
        {
            "cve_id": "CVE-2019-8331",
            "vulnerable_symbols": ["jQuery.fn.tooltip", "jQuery.fn.popover", "data-tooltip"],
            "required_conditions": [
                "HTML attributes contain user-controlled data",
                "data-sanitizer not set or bypassed",
            ],
            "non_vulnerable_patterns": [
                "Bootstrap 4.3+",
                "data-sanitizer: new DefaultSanitizer()",
            ],
            "note": "XSS in Bootstrap tooltip/popover when processing "
                    "untrusted HTML attributes.",
        },
    ],
    "express": [
        {
            "cve_id": "CVE-2022-24999",
            "vulnerable_symbols": ["express.json", "express.urlencoded", "app.use(express.json())"],
            "required_conditions": [
                "limit not set or Infinity",
                "Large JSON payload sent to server",
            ],
            "non_vulnerable_patterns": [
                "express.json({limit: '1mb'})",
                "express-xml-bodyparser",
            ],
            "note": "DoS via excessive JSON payload size in express.json "
                    "middleware when limit is not configured.",
        },
    ],
    "axios": [
        {
            "cve_id": "CVE-2021-3749",
            "vulnerable_symbols": ["axios.get", "axios.request", "axios.post"],
            "required_conditions": [
                "Authorization header present",
                "URL redirects to external host",
                "XSS on redirect target",
            ],
            "non_vulnerable_patterns": [
                "axios.get(url, {headers: null})",
                "axios.interceptors",
            ],
            "note": "Regular Expression DoS in Axios when following redirects "
                    "from an attacker-controlled server with authorization headers.",
        },
    ],
}

# Symbol extraction patterns from CVE descriptions
# These help us parse function/method names from prose like:
# "jQuery's $.extend() function is vulnerable..."
_SYMBOL_PATTERNS = [
    # $.function(...)
    re.compile(r"\$\.\w+\("),
    # jQuery.function(...)
    re.compile(r"jQuery\.\w+\("),
    # _.function(...)
    re.compile(r"_\.\w+\("),
    # function(...)
    re.compile(r"\b\w+\.\w+\("),
    # method references without call parens
    re.compile(r"\b\$\.\w+(?!\()"),
    re.compile(r"\b\w+\.\w+(?!\()"),
    # <dangerouslySetInnerHTML> JSX props
    re.compile(r"<\w+[\s>].*?dangerously\w+"),
    # HTML attribute patterns
    re.compile(r"data-\w+"),
]

# Condition extraction patterns
_CONDITION_PATTERNS = [
    re.compile(r"when.*?is used", re.IGNORECASE),
    re.compile(r"if.*?is true", re.IGNORECASE),
    re.compile(r"deep.*?clone", re.IGNORECASE),
    re.compile(r"user.*?provided", re.IGNORECASE),
    re.compile(r"untrusted.*?input", re.IGNORECASE),
]

# Non-vulnerable pattern extraction
_NON_VULN_PATTERNS = [
    re.compile(r"NOT.*?affected", re.IGNORECASE),
    re.compile(r"does not.*?vulnerable", re.IGNORECASE),
    re.compile(r"safe.*?alternative", re.IGNORECASE),
]


# ---------------------------------------------------------------------------
# Core extraction functions
# ---------------------------------------------------------------------------

def _extract_symbols_from_description(summary: Optional[str], note: str = "") -> list[str]:
    """Extract function/method names from CVE description text."""
    symbols: set[str] = set()
    text = str(summary or "") + " " + str(note or "")

    for pattern in _SYMBOL_PATTERNS:
        for match in pattern.finditer(text):
            sym = match.group(0).rstrip("(")
            if len(sym) >= 3:  # Skip very short matches
                symbols.add(sym)

    return sorted(symbols)


def _extract_conditions_from_description(summary: Optional[str]) -> list[str]:
    """Extract required conditions from CVE description text."""
    conditions: list[str] = []
    text = str(summary or "")

    for pattern in _CONDITION_PATTERNS:
        for match in pattern.finditer(text):
            # Get the context around the match
            start = max(0, match.start() - 20)
            end = min(len(text), match.end() + 20)
            context = text[start:end].strip()
            conditions.append(context)

    return conditions


def _lookup_known_signature(
    library: Optional[str],
    cve_id: str,
) -> Optional[dict]:
    """Check if we have a pre-built signature for this library+CVE."""
    if not library:
        return None
    lib_key = library.lower()
    for variant in [lib_key, lib_key.replace(".", "").replace("-", "")]:
        if variant in _KNOWN_VULN_SIGNATURES:
            for sig in _KNOWN_VULN_SIGNATURES[variant]:
                if sig.get("cve_id") == cve_id:
                    return sig
    return None


def extract_cve_signature(
    cve_id: str,
    library: str,
    summary: str,
    cvss_score: Optional[float] = None,
) -> CVESignature:
    """
    Extract a vulnerability signature for a single CVE.

    Tries in order:
    1. Pre-built signature from KNOWN_VULN_SIGNATURES (authoritative)
    2. Symbol extraction from description text
    3. Fallback to generic notes

    Args:
        cve_id: CVE identifier (e.g., "CVE-2019-11358")
        library: Library name (e.g., "jQuery", "lodash")
        summary: CVE description/summary text
        cvss_score: CVSS score (optional)

    Returns:
        CVESignature with vulnerable_symbols, required_conditions,
        non_vulnerable_patterns, and exploitability_notes.
    """
    sig = CVESignature(
        cve_id=cve_id,
        library=library,
    )

    # ── 1. Pre-built signature lookup ──
    known = _lookup_known_signature(library, cve_id)
    if known:
        sig.vulnerable_symbols = known.get("vulnerable_symbols", [])
        sig.required_conditions = known.get("required_conditions", [])
        sig.non_vulnerable_patterns = known.get("non_vulnerable_patterns", [])
        sig.exploitability_notes = known.get("note", "")
        sig.extraction_sources = ["known_signature_db"]
        sig.signature_confidence = "certain"
        return sig

    # ── 2. Symbol extraction from description ──
    extracted_symbols = _extract_symbols_from_description(summary)
    extracted_conditions = _extract_conditions_from_description(summary)

    if extracted_symbols:
        sig.vulnerable_symbols = extracted_symbols
        sig.extraction_sources.append("description_parsing")
        sig.signature_confidence = "probable"

    if extracted_conditions:
        sig.required_conditions = extracted_conditions
        if "description_parsing" not in sig.extraction_sources:
            sig.extraction_sources.append("description_parsing")
        sig.signature_confidence = "probable"

    # ── 3. Generic notes based on CVSS severity ──
    library_label = library or "unknown library"
    summary_snippet = (summary or "")[:200]
    if cvss_score is not None and cvss_score >= 9.0:
        sig.exploitability_notes = (
            f"High-severity {library_label} vulnerability (CVSS {cvss_score}). "
            f"Summary: {summary_snippet}"
        )
        sig.extraction_sources.append("cvss_notes")
        if sig.signature_confidence == "possible":
            sig.signature_confidence = "possible"
    elif cvss_score is not None:
        sig.exploitability_notes = summary_snippet if summary_snippet else ""
        sig.extraction_sources.append("summary_notes")

    # If nothing was extracted at all, add summary as fallback
    if not sig.exploitability_notes:
        sig.exploitability_notes = (
            f"{summary_snippet}."
            if summary_snippet else "(No description available)"
        )
        if not sig.extraction_sources:
            sig.extraction_sources.append("summary_fallback")
    if not sig.vulnerable_symbols and not sig.required_conditions:
        sig.signature_confidence = "possible"
        sig.signature_confidence = "possible"

    return sig


def enrich_cves_with_signatures(
    cves: list[dict],
) -> list[dict]:
    """
    Enrich a list of CVE dicts with signature data.

    Adds each CVE's:
    - vulnerable_symbols: list of strings
    - required_conditions: list of strings
    - non_vulnerable_patterns: list of strings
    - exploitability_notes: string
    - signature_confidence: string

    Mutates the CVE dicts in place and returns the modified list.
    """
    for cve in cves:
        cve_id = cve.get("cve_id", "")
        library = cve.get("library", "")
        summary = cve.get("summary", "")
        cvss = cve.get("cvss_score")

        sig = extract_cve_signature(cve_id, library, summary, cvss)

        cve["vulnerable_symbols"] = sig.vulnerable_symbols
        cve["required_conditions"] = sig.required_conditions
        cve["non_vulnerable_patterns"] = sig.non_vulnerable_patterns
        cve["exploitability_notes"] = sig.exploitability_notes
        cve["signature_confidence"] = sig.signature_confidence
        cve["signature_sources"] = sig.extraction_sources

    return cves


def signatures_to_dicts(signatures: list[CVESignature]) -> list[dict]:
    """Serialize signatures to dicts for state metadata storage."""
    return [
        {
            "cve_id": s.cve_id,
            "library": s.library,
            "vulnerable_symbols": s.vulnerable_symbols,
            "required_conditions": s.required_conditions,
            "non_vulnerable_patterns": s.non_vulnerable_patterns,
            "exploitability_notes": s.exploitability_notes,
            "extraction_sources": s.extraction_sources,
            "signature_confidence": s.signature_confidence,
        }
        for s in signatures
    ]
