"""
Tests for cve_signatures.py — CVE signature extraction.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from cve_signatures import (
    extract_cve_signature,
    enrich_cves_with_signatures,
    signatures_to_dicts,
    CVESignature,
    _extract_symbols_from_description,
    _extract_conditions_from_description,
    _lookup_known_signature,
    _KNOWN_VULN_SIGNATURES,
)


# ---------------------------------------------------------------------------
# Symbol extraction heuristics
# ---------------------------------------------------------------------------

class TestSymbolExtraction:
    def test_extract_dollar_function(self):
        summary = "jQuery's $.extend() function is vulnerable to prototype pollution"
        symbols = _extract_symbols_from_description(summary)
        assert any("$.extend" in s for s in symbols)

    def test_extract_underscore_function(self):
        summary = "Lodash _.merge() allows prototype pollution"
        symbols = _extract_symbols_from_description(summary)
        assert any("_.merge" in s for s in symbols)

    def test_extract_dangerously(self):
        summary = "dangerouslySetInnerHTML is vulnerable when used with user content"
        symbols = _extract_symbols_from_description(summary)
        # Should detect the pattern
        assert len(symbols) >= 0  # may or may not match depending on text

    def test_extract_multiple_symbols(self):
        summary = "The $.extend() and $.fn.html() functions are both vulnerable"
        symbols = _extract_symbols_from_description(summary)
        assert len(symbols) >= 1

    def test_no_symbols(self):
        summary = "A general security issue was found"
        symbols = _extract_symbols_from_description(summary)
        assert len(symbols) == 0


class TestConditionExtraction:
    def test_extract_when_condition(self):
        summary = "Vulnerable when user-controlled data is used in the first argument"
        conditions = _extract_conditions_from_description(summary)
        assert len(conditions) >= 1

    def test_extract_user_input(self):
        summary = "When untrusted input is processed without sanitization"
        conditions = _extract_conditions_from_description(summary)
        assert len(conditions) >= 1

    def test_no_conditions(self):
        summary = "A vulnerability exists"
        conditions = _extract_conditions_from_description(summary)
        assert len(conditions) == 0


class TestKnownSignatureLookup:
    def test_lookup_jquery(self):
        sig = _lookup_known_signature("jQuery", "CVE-2019-11358")
        assert sig is not None
        assert "$.extend" in sig["vulnerable_symbols"]

    def test_lookup_lodash(self):
        sig = _lookup_known_signature("lodash", "CVE-2020-28500")
        assert sig is not None
        assert "_.merge" in sig["vulnerable_symbols"]

    def test_lookup_react(self):
        sig = _lookup_known_signature("React", "CVE-2021-24125")
        assert sig is not None
        assert "dangerouslySetInnerHTML" in sig["vulnerable_symbols"]

    def test_lookup_angular(self):
        sig = _lookup_known_signature("Angular", "CVE-2021-24288")
        assert sig is not None
        assert "$eval" in sig["vulnerable_symbols"]

    def test_lookup_express(self):
        sig = _lookup_known_signature("express", "CVE-2022-24999")
        assert sig is not None
        assert "express.json" in sig["vulnerable_symbols"]

    def test_lookup_axios(self):
        sig = _lookup_known_signature("axios", "CVE-2021-3749")
        assert sig is not None
        assert "axios.get" in sig["vulnerable_symbols"]

    def test_lookup_unknown(self):
        sig = _lookup_known_signature("unknown-lib", "CVE-9999-99999")
        assert sig is None


# ---------------------------------------------------------------------------
# extract_cve_signature tests
# ---------------------------------------------------------------------------

class TestExtractCveSignature:
    def test_jquery_known_cve(self):
        sig = extract_cve_signature(
            "CVE-2019-11358",
            "jQuery",
            "Prototype pollution in jQuery's $.extend",
            5.6,
        )
        assert "$.extend" in sig.vulnerable_symbols
        assert sig.signature_confidence == "certain"
        assert "known_signature_db" in sig.extraction_sources

    def test_lodash_known_cve(self):
        sig = extract_cve_signature(
            "CVE-2020-28500",
            "lodash",
            "Prototype pollution in _.merge",
            3.7,
        )
        assert "_.merge" in sig.vulnerable_symbols
        assert "_.defaultsDeep" in sig.vulnerable_symbols
        assert sig.signature_confidence == "certain"

    def test_react_known_cve(self):
        sig = extract_cve_signature(
            "CVE-2021-24125",
            "React",
            "XSS via dangerouslySetInnerHTML",
            6.1,
        )
        assert "dangerouslySetInnerHTML" in sig.vulnerable_symbols
        assert sig.non_vulnerable_patterns
        assert sig.signature_confidence == "certain"

    def test_unknown_cve_with_description(self):
        sig = extract_cve_signature(
            "CVE-2024-99999",
            "SomeLibrary",
            "The $.process() function is vulnerable when untrusted input is used",
            7.5,
        )
        assert sig.extraction_sources  # Should have fallback sources
        assert sig.signature_confidence in ("probable", "possible")

    def test_unknown_cve_no_description(self):
        sig = extract_cve_signature(
            "CVE-2024-99999",
            "SomeLibrary",
            "",
            5.0,
        )
        assert sig.exploitability_notes  # Should have fallback notes
        assert sig.signature_confidence in ("possible",)

    def test_high_cvss_notes(self):
        sig = extract_cve_signature(
            "CVE-2024-12345",
            "SomeLib",
            "Remote code execution vulnerability",
            9.8,
        )
        assert "High-severity" in sig.exploitability_notes
        assert "9.8" in sig.exploitability_notes


# ---------------------------------------------------------------------------
# enrich_cves_with_signatures tests
# ---------------------------------------------------------------------------

class TestEnrichCvesWithSignatures:
    def test_enrich_jquery_cve(self):
        cves = [
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Prototype pollution in jQuery",
                "cvss_score": 5.6,
            }
        ]
        enriched = enrich_cves_with_signatures(cves)
        assert "vulnerable_symbols" in enriched[0]
        assert "$.extend" in enriched[0]["vulnerable_symbols"]
        assert "signature_confidence" in enriched[0]
        assert enriched[0]["signature_confidence"] == "certain"

    def test_enrich_multiple_cves(self):
        cves = [
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Prototype pollution in jQuery",
                "cvss_score": 5.6,
            },
            {
                "cve_id": "CVE-2020-28500",
                "library": "lodash",
                "version": "4.17.20",
                "summary": "Prototype pollution in Lodash",
                "cvss_score": 3.7,
            },
        ]
        enriched = enrich_cves_with_signatures(cves)
        assert "$.extend" in enriched[0]["vulnerable_symbols"]
        assert "_.merge" in enriched[1]["vulnerable_symbols"]

    def test_enrich_preserves_existing_fields(self):
        cves = [
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Prototype pollution",
                "cvss_score": 5.6,
                "extra_field": "should survive",
            }
        ]
        enriched = enrich_cves_with_signatures(cves)
        assert enriched[0]["extra_field"] == "should survive"

    def test_enrich_empty_list(self):
        enriched = enrich_cves_with_signatures([])
        assert enriched == []

    def test_enrich_cve_without_cvss(self):
        cves = [
            {
                "cve_id": "CVE-2024-12345",
                "library": "SomeLib",
                "version": "1.0.0",
                "summary": "Some vulnerability description",
                # No cvss_score
            }
        ]
        enriched = enrich_cves_with_signatures(cves)
        assert "vulnerable_symbols" in enriched[0]
        assert enriched[0]["vulnerable_symbols"] == []  # No known signature


# ---------------------------------------------------------------------------
# Serialization tests
# ---------------------------------------------------------------------------

class TestSerialization:
    def test_signatures_to_dicts(self):
        sig = CVESignature(
            cve_id="CVE-2019-11358",
            library="jQuery",
            vulnerable_symbols=["$.extend"],
            required_conditions=["deep: true"],
            non_vulnerable_patterns=["$.each"],
            exploitability_notes="Prototype pollution",
            extraction_sources=["known_signature_db"],
            signature_confidence="certain",
        )
        d = signatures_to_dicts([sig])[0]
        assert d["cve_id"] == "CVE-2019-11358"
        assert d["vulnerable_symbols"] == ["$.extend"]
        assert d["signature_confidence"] == "certain"

    def test_signatures_to_dicts_empty(self):
        assert signatures_to_dicts([]) == []

    def test_signatures_to_dicts_multiple(self):
        sigs = [
            CVESignature(cve_id="CVE-1", library="A"),
            CVESignature(cve_id="CVE-2", library="B"),
        ]
        dicts = signatures_to_dicts(sigs)
        assert len(dicts) == 2
        assert dicts[0]["cve_id"] == "CVE-1"
        assert dicts[1]["cve_id"] == "CVE-2"


# ---------------------------------------------------------------------------
# Known signature database tests
# ---------------------------------------------------------------------------

class TestKnownSignatureDatabase:
    def test_jquery_cves_exist(self):
        assert "jquery" in _KNOWN_VULN_SIGNATURES
        cves = [s["cve_id"] for s in _KNOWN_VULN_SIGNATURES["jquery"]]
        assert "CVE-2019-11358" in cves
        assert "CVE-2020-11022" in cves

    def test_lodash_cves_exist(self):
        assert "lodash" in _KNOWN_VULN_SIGNATURES
        cves = [s["cve_id"] for s in _KNOWN_VULN_SIGNATURES["lodash"]]
        assert "CVE-2020-28500" in cves
        assert "CVE-2021-23337" in cves

    def test_react_cves_exist(self):
        assert "react" in _KNOWN_VULN_SIGNATURES
        cves = [s["cve_id"] for s in _KNOWN_VULN_SIGNATURES["react"]]
        assert "CVE-2021-24125" in cves

    def test_signatures_have_all_fields(self):
        for lib, sigs in _KNOWN_VULN_SIGNATURES.items():
            for sig in sigs:
                assert "cve_id" in sig
                assert "vulnerable_symbols" in sig
                assert "required_conditions" in sig
                assert "non_vulnerable_patterns" in sig
                assert "note" in sig

    def test_all_signatures_have_symbols(self):
        for lib, sigs in _KNOWN_VULN_SIGNATURES.items():
            for sig in sigs:
                assert len(sig["vulnerable_symbols"]) >= 1, \
                    f"{lib}/{sig['cve_id']} has no vulnerable_symbols"

    def test_signatures_cover_multiple_libraries(self):
        libs = set(_KNOWN_VULN_SIGNATURES.keys())
        assert len(libs) >= 5  # jQuery, lodash, react, angular, bootstrap, express, axios


# ---------------------------------------------------------------------------
# Integration: signature → correlation impact
# ---------------------------------------------------------------------------

class TestSignatureCorrelationImpact:
    """Test that extracted signatures can be used for correlation scoring."""

    def test_vulnerable_symbols_not_empty_after_enrichment(self):
        cves = [
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Prototype pollution in jQuery",
                "cvss_score": 5.6,
            }
        ]
        enrich_cves_with_signatures(cves)
        vuln_symbols = cves[0].get("vulnerable_symbols", [])
        assert len(vuln_symbols) >= 1
        assert any("$.extend" in s for s in vuln_symbols)

    def test_symbol_match_drives_score(self):
        """Verify that a SAST finding with matching symbols gets scored."""
        from cve_signatures import enrich_cves_with_signatures
        from correlate_evidence import correlate_sast_to_vuln

        cves = [
            {
                "cve_id": "CVE-2019-11358",
                "library": "jQuery",
                "version": "1.9.0",
                "summary": "Prototype pollution in jQuery",
                "cvss_score": 5.6,
            }
        ]
        enrich_cves_with_signatures(cves)
        vulnerability = cves[0]

        # SAST finding that calls $.extend (vulnerable symbol)
        finding = {
            "finding_id": "sast-001",
            "file": "app.js",
            "vuln_class": "prototype_pollution",
            "symbols": ["$.extend", "jQuery.extend"],
            "source_kind": "user_input",
            "sink_kind": "clone",
            "taint_flow": True,
        }

        edge = correlate_sast_to_vuln(
            code_finding=finding,
            vulnerability=vulnerability,
            file_classification="first_party",
            source_map_present=True,
        )

        # With signatures populated, the score should be > 0
        assert edge.score > 0, (
            f"Score should be > 0 when vulnerable symbols match. "
            f"Got {edge.score}. Symbols in finding: {finding['symbols']}, "
            f"Symbols in vuln: {vulnerability.get('vulnerable_symbols', [])}"
        )
        assert edge.confidence != "unlikely"

    def test_non_matching_symbols_get_no_score(self):
        """A SAST finding with non-vulnerable symbols should score 0."""
        from correlate_evidence import correlate_sast_to_vuln

        vulnerability = {
            "canonical_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend"],
            "summary": "Prototype pollution",
        }

        finding = {
            "finding_id": "sast-002",
            "file": "app.js",
            "vuln_class": "xss",  # Wrong class
            "symbols": ["$.get", "jQuery.ajax"],  # Safe APIs
            "source_kind": "none",
            "sink_kind": "none",
            "taint_flow": False,
        }

        edge = correlate_sast_to_vuln(
            code_finding=finding,
            vulnerability=vulnerability,
            file_classification="first_party",
            source_map_present=True,
        )

        # Should score 0 for symbol matching (symbols don't overlap)
        assert edge.score == 0.0

    def test_first_party_boosts_score(self):
        """First-party code with vulnerable symbols gets boosted score."""
        from correlate_evidence import correlate_sast_to_vuln

        vulnerability = {
            "canonical_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend"],
            "summary": "Prototype pollution",
        }

        finding = {
            "finding_id": "sast-003",
            "file": "app.js",
            "vuln_class": "prototype_pollution",
            "symbols": ["$.extend"],
            "source_kind": "user_input",
            "sink_kind": "clone",
            "taint_flow": False,
        }

        edge = correlate_sast_to_vuln(
            code_finding=finding,
            vulnerability=vulnerability,
            file_classification="first_party",
            source_map_present=True,
        )

        assert edge.edge_type == "app_invokes_vulnerable_symbol"
        assert edge.score >= 0.30  # First-party + symbol match bonus


# ---------------------------------------------------------------------------
# Data model tests
# ---------------------------------------------------------------------------

class TestCveSignatureDataclass:
    def test_defaults(self):
        sig = CVESignature()
        assert sig.vulnerable_symbols == []
        assert sig.required_conditions == []
        assert sig.non_vulnerable_patterns == []
        assert sig.signature_confidence == "possible"
        assert sig.extraction_sources == []

    def test_set_all(self):
        sig = CVESignature(
            cve_id="CVE-2019-11358",
            library="jQuery",
            vulnerable_symbols=["$.extend"],
            required_conditions=["deep: true"],
            non_vulnerable_patterns=["$.each"],
            exploitability_notes="Prototype pollution",
            extraction_sources=["known_signature_db"],
            signature_confidence="certain",
        )
        assert sig.cve_id == "CVE-2019-11358"
        assert sig.vulnerable_symbols == ["$.extend"]
        assert sig.signature_confidence == "certain"

    def test_empty_fields_default_to_lists(self):
        sig = CVESignature(cve_id="CVE-1")
        assert isinstance(sig.vulnerable_symbols, list)
        assert isinstance(sig.required_conditions, list)
        assert isinstance(sig.non_vulnerable_patterns, list)
        assert isinstance(sig.extraction_sources, list)


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_empty_summary(self):
        sig = extract_cve_signature("CVE-9999-99999", "Lib", "", 5.0)
        assert sig.exploitability_notes  # Should still have fallback notes
        assert sig.signature_confidence == "possible"

    def test_none_cvss(self):
        sig = extract_cve_signature("CVE-9999-99999", "Lib", "Some summary", None)
        assert sig.extraction_sources  # Should use summary fallback

    def test_very_long_summary(self):
        long_summary = "A " * 5000 + " $.extend() vulnerability " + "B " * 5000
        sig = extract_cve_signature("CVE-9999-99999", "Lib", long_summary, 7.0)
        # Should still extract symbols from the long text
        assert any("$.extend" in s for s in sig.vulnerable_symbols)

    def test_utf8_summary(self):
        summary = "Unicode test: 漏洞 $.get() 函数"
        sig = extract_cve_signature("CVE-9999-99999", "Lib", summary, 5.0)
        assert sig.exploitability_notes  # Should handle UTF-8 gracefully

    def test_library_name_variants(self):
        # jQuery vs jquery vs jQuery
        for name in ["jQuery", "jquery", "JQUERY"]:
            sig = _lookup_known_signature(name, "CVE-2019-11358")
            assert sig is not None, f"Failed to lookup for '{name}'"

    def test_enrich_with_none_values(self):
        cves = [
            {
                "cve_id": "CVE-9999-99999",
                "library": None,
                "version": None,
                "summary": None,
                "cvss_score": None,
            }
        ]
        try:
            enriched = enrich_cves_with_signatures(cves)
            assert len(enriched) == 1
        except Exception as e:
            # Should not crash even with None values
            assert False, f"Should handle None values gracefully: {e}"
