"""
Tests for dedup_vulnerabilities.py — Vulnerability normalization and dedup.
"""

import sys
from pathlib import Path

# Ensure scripts directory is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from dedup_vulnerabilities import (
    Vulnerability,
    dedup_vulnerabilities,
    vulnerabilities_to_dicts,
    canonicalize_aliases,
    parse_cvss_score,
    _CVE_PATTERN,
    _GHSA_PATTERN,
    _OSV_PATTERN,
)


# ---------------------------------------------------------------------------
# Pattern tests
# ---------------------------------------------------------------------------

class TestPatterns:
    """Tests for ID format patterns."""

    def test_cve_pattern_valid(self):
        assert _CVE_PATTERN.match("CVE-2019-11358")
        assert _CVE_PATTERN.match("CVE-2024-0001")
        assert _CVE_PATTERN.match("CVE-2025-123456")

    def test_cve_pattern_invalid(self):
        # The pattern is case-insensitive (matches both upper and lowercase),
        # but the canonicalize_aliases function uppercases input before matching.
        # These strings simply aren't CVE format.
        assert not _CVE_PATTERN.match("GHSA-xxxx-xxxx-xxxx")
        assert not _CVE_PATTERN.match("OSV-2024-1")
        assert not _CVE_PATTERN.match("not-a-cve")
        assert not _CVE_PATTERN.match("CVE-2019")  # missing NNNN

    def test_ghsa_pattern_valid(self):
        assert _GHSA_PATTERN.match("GHSA-jjq5-92xg-8wr3")
        assert _GHSA_PATTERN.match("GHSA-1234-abcd-efgh")

    def test_ghsa_pattern_invalid(self):
        assert not _GHSA_PATTERN.match("CVE-2019-11358")
        assert not _GHSA_PATTERN.match("GHSA-short")

    def test_osv_pattern_valid(self):
        assert _OSV_PATTERN.match("OSV-2024-1")
        assert _OSV_PATTERN.match("OSV-2025-12345")


# ---------------------------------------------------------------------------
# canonicalize_aliases tests
# ---------------------------------------------------------------------------

class TestCanonicalizeAliases:
    """Tests for alias canonicalization."""

    def test_cve_preferred(self):
        canonical, normalized = canonicalize_aliases([
            "GHSA-jjq5-92xg-8wr3",
            "CVE-2019-11358",
        ])
        assert canonical == "CVE-2019-11358"
        # Aliases are normalized to uppercase
        assert "CVE-2019-11358" in normalized
        assert "GHSA-JJQ5-92XG-8WR3" in normalized

    def test_ghsa_when_no_cve(self):
        canonical, normalized = canonicalize_aliases([
            "GHSA-jjq5-92xg-8wr3",
            "OSV-2024-1",
        ])
        assert canonical == "GHSA-JJQ5-92XG-8WR3"

    def test_uppercase_normalization(self):
        canonical, normalized = canonicalize_aliases([
            "cve-2019-11358",
            "CVE-2019-11358",
        ])
        # Both normalize to the same, dedup
        assert canonical == "CVE-2019-11358"
        assert normalized == ["CVE-2019-11358"]

    def test_empty_list(self):
        assert canonicalize_aliases([]) == ("", [])

    def test_whitespace_stripped(self):
        canonical, normalized = canonicalize_aliases([
            "  CVE-2019-11358  ",
            "CVE-2019-11358",
        ])
        assert canonical == "CVE-2019-11358"
        assert len(normalized) == 1

    def test_dedup_preserves_order(self):
        canonical, normalized = canonicalize_aliases([
            "OSV-2024-1",
            "CVE-2024-0001",
            "GHSA-abcd-efgh-ijkl",
        ])
        assert canonical == "CVE-2024-0001"
        # Original order preserved
        assert normalized.index("OSV-2024-1") < normalized.index("CVE-2024-0001")
        assert normalized.index("CVE-2024-0001") < normalized.index("GHSA-ABCD-EFGH-IJKL")

    def test_fallback_to_first(self):
        # No CVE/GHSA/OSV pattern
        canonical, normalized = canonicalize_aliases([
            "PROPRIETARY-ID-123",
            "ANOTHER-ID-456",
        ])
        assert canonical == "PROPRIETARY-ID-123"


# ---------------------------------------------------------------------------
# parse_cvss_score tests
# ---------------------------------------------------------------------------

class TestParseCvssScore:
    """Tests for CVSS score extraction."""

    def test_none(self):
        assert parse_cvss_score(None) is None

    def test_float(self):
        assert parse_cvss_score(7.5) == 7.5
        assert parse_cvss_score(0) == 0.0
        assert parse_cvss_score(10) == 10.0

    def test_string_number(self):
        assert parse_cvss_score("7.5") == 7.5
        assert parse_cvss_score("0") == 0.0

    def test_osv_list_format(self):
        # OSV format: list of {type, score}
        data = [{"type": "CVSS_V3", "score": "7.5"}]
        assert parse_cvss_score(data) == 7.5

    def test_osv_list_with_multiple(self):
        # First valid score wins
        data = [
            {"type": "CVSS_V2", "score": "5.0"},
            {"type": "CVSS_V3", "score": "7.5"},
        ]
        assert parse_cvss_score(data) == 5.0

    def test_nvd_dict_format(self):
        data = {"baseScore": 7.5, "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}
        assert parse_cvss_score(data) == 7.5

    def test_vector_string_returns_none(self):
        # We don't have a vector→score lookup
        assert parse_cvss_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H") is None

    def test_invalid_string(self):
        assert parse_cvss_score("not a number") is None

    def test_empty_list(self):
        assert parse_cvss_score([]) is None


# ---------------------------------------------------------------------------
# dedup_vulnerabilities tests
# ---------------------------------------------------------------------------

class TestDedupVulnerabilities:
    """Tests for the main dedup_vulnerabilities entry point."""

    def test_single_cve(self):
        raw = [{
            "cve_id": "CVE-2019-11358",
            "library": "jQuery",
            "version": "1.9.0",
            "summary": "XSS in jQuery",
            "cvss_score": 6.1,
            "source": "osv.dev",
        }]
        result = dedup_vulnerabilities(raw)
        assert len(result) == 1
        assert result[0].canonical_id == "CVE-2019-11358"
        assert result[0].aliases == ["CVE-2019-11358"]
        assert result[0].cvss == 6.1
        assert result[0].source == "osv.dev"
        assert result[0].sources == ["osv.dev"]

    def test_merge_from_two_sources(self):
        # Same CVE from OSV.dev and VulnLookup should merge
        raw = [
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Short",
                "cvss_score": 6.1,
                "source": "osv.dev",
            },
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Much longer and more detailed summary with more context",
                "cvss_score": 6.5,  # higher
                "source": "vuln-lookup",
            },
        ]
        result = dedup_vulnerabilities(raw)
        assert len(result) == 1
        assert result[0].canonical_id == "CVE-2019-11358"
        assert set(result[0].sources) == {"osv.dev", "vuln-lookup"}
        assert "merged" in result[0].source or "," in result[0].source
        # Higher score wins
        assert result[0].cvss == 6.5
        # Longer summary wins
        assert "more context" in result[0].summary

    def test_lowercase_normalized(self):
        raw = [{
            "cve_id": "cve-2019-11358",  # lowercase
            "source": "vuln-lookup",
        }]
        result = dedup_vulnerabilities(raw)
        assert len(result) == 1
        assert result[0].canonical_id == "CVE-2019-11358"

    def test_empty_input(self):
        assert dedup_vulnerabilities([]) == []

    def test_ghsa_only(self):
        raw = [{
            "cve_id": "GHSA-jjq5-92xg-8wr3",
            "source": "osv.dev",
        }]
        result = dedup_vulnerabilities(raw)
        assert len(result) == 1
        # canonical_id is uppercase
        assert result[0].canonical_id == "GHSA-JJQ5-92XG-8WR3"

    def test_aliases_field_used(self):
        # If 'aliases' field is present, it's merged with cve_id
        raw = [{
            "cve_id": "CVE-2019-11358",
            "aliases": ["GHSA-jjq5-92xg-8wr3"],
            "source": "osv.dev",
        }]
        result = dedup_vulnerabilities(raw)
        assert len(result) == 1
        # Both IDs are in the aliases list (uppercased)
        assert "CVE-2019-11358" in result[0].aliases
        assert "GHSA-JJQ5-92XG-8WR3" in result[0].aliases

    def test_invalid_records_skipped(self):
        raw = [
            {"cve_id": "", "source": "osv.dev"},  # no cve_id
            {"source": "osv.dev"},  # no cve_id at all
            {"cve_id": "CVE-2020-0001", "source": "osv.dev"},
        ]
        result = dedup_vulnerabilities(raw)
        assert len(result) == 1
        assert result[0].canonical_id == "CVE-2020-0001"


# ---------------------------------------------------------------------------
# Serialization tests
# ---------------------------------------------------------------------------

class TestVulnerabilitiesToDicts:
    """Tests for vulnerabilities_to_dicts serialization."""

    def test_serialize_basic(self):
        v = Vulnerability(
            canonical_id="CVE-2019-11358",
            aliases=["CVE-2019-11358", "GHSA-jjq5-92xg-8wr3"],
            summary="XSS",
            cvss=6.1,
            source="merged",
        )
        d = vulnerabilities_to_dicts([v])[0]
        assert d["canonical_id"] == "CVE-2019-11358"
        assert d["aliases"] == ["CVE-2019-11358", "GHSA-jjq5-92xg-8wr3"]
        assert d["cvss"] == 6.1
        assert d["source"] == "merged"
        assert d["cwes"] == []
        assert d["affected"] == []

    def test_serialize_with_enrichment(self):
        v = Vulnerability(
            canonical_id="CVE-2019-11358",
            cwes=["CWE-79"],
            affected=[{"introduced": "1.1.4", "fixed": "3.4.0"}],
            fixed_versions=["3.4.0"],
            epss=0.42,
            kev=True,
            references=["https://nvd.nist.gov/vuln/detail/CVE-2019-11358"],
        )
        d = vulnerabilities_to_dicts([v])[0]
        assert d["cwes"] == ["CWE-79"]
        assert d["fixed_versions"] == ["3.4.0"]
        assert d["epss"] == 0.42
        assert d["kev"] is True
        assert len(d["references"]) == 1
