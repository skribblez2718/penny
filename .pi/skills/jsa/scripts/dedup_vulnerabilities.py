"""
jsa Skill — Vulnerability normalization and deduplication

Reconciles CVE/GHSA/OSV records from multiple databases (OSV.dev,
Vulnerability-Lookup) into a single canonical Vulnerability record per CVE.
Handles alias canonicalization and enrichment with CVSS, EPSS, KEV, CWE.

Why a separate module:
- CVE alias canonicalization (CVE-2024-0001 vs GHSA-xxxx vs OSV-xxx) is a
  fundamentally different operation from component dedup or SAST fingerprint
  dedup. Splitting makes each easier to test and evolve.
- This is the second of three split modules: components, vulnerabilities,
  code findings.

Inputs:
- Raw CVE records from cve_lookup (already deduped by CVE ID uppercased)
- Future: enrichment from EPSS/KEV/CWE sources

Outputs:
- List of normalized Vulnerability records with canonical IDs, aliases,
  affected ranges, fixed versions, severity enrichment
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
import re


# ---------------------------------------------------------------------------
# Vulnerability dataclass
# ---------------------------------------------------------------------------

@dataclass
class Vulnerability:
    """Canonical vulnerability record after dedup and enrichment.

    canonical_id is the preferred identifier (CVE when available, otherwise
    GHSA or OSV). aliases lists all known identifiers. affected lists version
    ranges where the vulnerability applies. enrichment holds scoring signals
    (CVSS, EPSS, KEV) for prioritization.
    """
    canonical_id: str = ""           # e.g., "CVE-2019-11358"
    aliases: list[str] = field(default_factory=list)  # all known IDs
    summary: str = ""
    affected: list[dict] = field(default_factory=list)  # [{"introduced": "1.1.4", "fixed": "3.4.0"}]
    fixed_versions: list[str] = field(default_factory=list)
    cwes: list[str] = field(default_factory=list)
    cvss: Optional[float] = None
    epss: Optional[float] = None  # 0.0 to 1.0 — probability of exploitation in 30 days
    kev: bool = False  # CISA Known Exploited Vulnerabilities
    references: list[str] = field(default_factory=list)
    source: str = ""  # "osv.dev" or "vuln-lookup" or "merged"
    # Provenance: which sources contributed data
    sources: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Alias canonicalization
# ---------------------------------------------------------------------------

# CVE IDs match: CVE-YYYY-NNNN (or NNNN+)
_CVE_PATTERN = re.compile(r"^CVE-\d{4}-\d{4,}$", re.IGNORECASE)

# GHSA IDs match: GHSA-xxxx-xxxx-xxxx (alphanumeric, 4-4-4 chars)
# Case-insensitive because canonicalize_aliases uppercases input
_GHSA_PATTERN = re.compile(r"^GHSA-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$", re.IGNORECASE)

# OSV IDs match: OSV-YYYY-NNN
_OSV_PATTERN = re.compile(r"^OSV-\d{4}-\d+$", re.IGNORECASE)


def canonicalize_aliases(aliases: list[str]) -> tuple[str, list[str]]:
    """
    Pick the canonical ID from a list of aliases.

    Preference order:
    1. CVE-XXXX-XXXX (industry standard, most widely used)
    2. GHSA-xxxx-xxxx-xxxx (GitHub Advisory)
    3. OSV-YYYY-NNN (Open Source Vulnerabilities)
    4. First non-empty alias

    Args:
        aliases: list of known identifiers (any case)

    Returns:
        (canonical_id, normalized_aliases) where normalized_aliases has
        all aliases uppercased and deduped.
    """
    if not aliases:
        return "", []

    # Uppercase and strip whitespace
    normalized = [a.strip().upper() for a in aliases if a and a.strip()]
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for a in normalized:
        if a not in seen:
            seen.add(a)
            unique.append(a)

    # Preference: CVE > GHSA > OSV > first
    for a in unique:
        if _CVE_PATTERN.match(a):
            return a, unique
    for a in unique:
        if _GHSA_PATTERN.match(a):
            return a, unique
    for a in unique:
        if _OSV_PATTERN.match(a):
            return a, unique

    # Fallback: first non-empty
    return unique[0], unique


# ---------------------------------------------------------------------------
# Severity enrichment
# ---------------------------------------------------------------------------

# Parse CVSS vectors and extract base score if available
def parse_cvss_score(cvss_data) -> Optional[float]:
    """
    Extract a numeric CVSS base score from various input formats:
    - float/int: returned as-is
    - string "7.5": parsed to float
    - string "CVSS:3.1/AV:N/AC:L/...": parsed from vector
    - list of dicts: extracted from {"score": ...}
    - None: returns None
    """
    if cvss_data is None:
        return None
    if isinstance(cvss_data, (int, float)):
        return float(cvss_data)
    if isinstance(cvss_data, str):
        # Try direct float parse
        try:
            return float(cvss_data)
        except (ValueError, TypeError):
            pass
        # Try extracting from vector
        # Format: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
        # We don't have a vector-to-score lookup, so return None
        # (a real implementation would use the NVD JSON or similar)
        return None
    if isinstance(cvss_data, list):
        # OSV.dev format: list of {type, score}
        for entry in cvss_data:
            if isinstance(entry, dict):
                score = entry.get("score")
                if isinstance(score, (int, float)):
                    return float(score)
                if isinstance(score, str):
                    try:
                        return float(score)
                    except (ValueError, TypeError):
                        pass
    if isinstance(cvss_data, dict):
        # NVD format: {"baseScore": 7.5}
        score = cvss_data.get("baseScore") or cvss_data.get("score")
        if isinstance(score, (int, float)):
            return float(score)
        if isinstance(score, str):
            try:
                return float(score)
            except (ValueError, TypeError):
                pass
    return None


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def dedup_vulnerabilities(raw_cves: list[dict]) -> list[Vulnerability]:
    """
    Normalize and deduplicate vulnerability records.

    Takes the raw CVE list from cve_lookup (already deduped by uppercase CVE ID)
    and produces a list of canonical Vulnerability records.

    Args:
        raw_cves: list of dicts from cve_lookup, each with:
            cve_id, summary, library, version, cvss_score, published_date,
            age_days, source, etc.
            May also contain 'aliases' (list of all known IDs).

    Returns:
        List of Vulnerability records, one per unique canonical CVE.

    Note: This handles intra-source dedup (same CVE from OSV and VulnLookup
    should merge into one record with sources=['osv.dev', 'vuln-lookup']).
    Cross-source merging is left to a future enhancement.
    """
    # Group by canonical_id
    by_canonical: dict[str, dict] = {}

    for raw in raw_cves:
        # Build the full alias list for this raw record
        aliases = list(raw.get("aliases") or [])
        if raw.get("cve_id"):
            aliases.append(raw["cve_id"])
        if raw.get("id"):
            aliases.append(raw["id"])

        canonical_id, normalized_aliases = canonicalize_aliases(aliases)
        if not canonical_id:
            continue

        if canonical_id not in by_canonical:
            by_canonical[canonical_id] = {
                "canonical_id": canonical_id,
                "aliases": normalized_aliases,
                "summary": raw.get("summary", ""),
                "library": raw.get("library", ""),
                "version": raw.get("version", ""),
                "cvss_score": raw.get("cvss_score"),
                "published_date": raw.get("published_date", ""),
                "source": raw.get("source", ""),
                "sources": {raw.get("source", "unknown")},
            }
        else:
            # Merge with existing record
            existing = by_canonical[canonical_id]
            # Merge aliases
            for a in normalized_aliases:
                if a not in existing["aliases"]:
                    existing["aliases"].append(a)
            # Track sources
            existing["sources"].add(raw.get("source", "unknown"))
            # Keep higher CVSS score
            new_score = raw.get("cvss_score")
            if new_score and (not existing.get("cvss_score") or new_score > existing["cvss_score"]):
                existing["cvss_score"] = new_score
            # Use longer summary if available
            if len(raw.get("summary", "")) > len(existing.get("summary", "")):
                existing["summary"] = raw.get("summary", "")

    # Convert to Vulnerability dataclass instances
    result: list[Vulnerability] = []
    for canon, data in by_canonical.items():
        sources_list = sorted(data["sources"])
        vuln = Vulnerability(
            canonical_id=canon,
            aliases=data["aliases"],
            summary=data.get("summary", ""),
            cvss=parse_cvss_score(data.get("cvss_score")),
            # Other fields (affected, fixed_versions, cwes, epss, kev) are
            # populated by future enrichment pass
            source=", ".join(sources_list) if sources_list else "unknown",
            sources=sources_list,
        )
        result.append(vuln)

    return result


def vulnerabilities_to_dicts(vulns: list[Vulnerability]) -> list[dict]:
    """Serialize vulnerabilities to dicts for state metadata storage."""
    return [
        {
            "canonical_id": v.canonical_id,
            "aliases": v.aliases,
            "summary": v.summary,
            "affected": v.affected,
            "fixed_versions": v.fixed_versions,
            "cwes": v.cwes,
            "cvss": v.cvss,
            "epss": v.epss,
            "kev": v.kev,
            "references": v.references,
            "source": v.source,
            "sources": v.sources,
        }
        for v in vulns
    ]
