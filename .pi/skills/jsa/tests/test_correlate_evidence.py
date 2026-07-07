"""
Tests for correlate_evidence.py — Cross-stream correlation with edges.
"""

import sys
from pathlib import Path

# Ensure scripts directory is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from correlate_evidence import (
    CorrelationEdge,
    correlate_component_vuln,
    correlate_sast_to_vuln,
    select_agent_candidates,
    edges_to_dicts,
    EDGE_COMPONENT_AFFECTED,
    EDGE_APP_INVOKES,
    EDGE_SAST_IN_COMPONENT,
)


# ---------------------------------------------------------------------------
# Hard gate tests
# ---------------------------------------------------------------------------

class TestHardGates:
    """Tests for hard gates that prevent or downgrade correlations."""

    def test_unknown_version_blocks_correlation(self):
        component = {
            "purl": "pkg:npm/jquery@?",
            "version": None,
            "loaded_on_pages": ["/"],
        }
        vuln = {"canonical_id": "CVE-2019-11358"}
        edge = correlate_component_vuln(component, vuln)
        assert edge.hard_negative is True
        assert edge.confidence == "unlikely"
        assert "No version" in edge.reason

    def test_known_version_passes_hard_gate(self):
        # Test that having a known version doesn't trigger the hard gate
        # (the "no version" gate). Score may be low due to penalties,
        # but the hard_negative flag should be False.
        component = {
            "purl": "pkg:npm/jquery@1.9.0",
            "version": "1.9.0",
            "loaded_on_pages": ["/"],
            "detection_evidence": [{"source": "wappalyzer", "has_version": True}],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "affected_packages": ["pkg:npm/jquery@1.9.0"],  # exact match
        }
        edge = correlate_component_vuln(component, vuln)
        # No hard_negative — version was known
        assert edge.hard_negative is False
        # Exact purl match + source_map evidence → high score
        assert edge.score >= 0.30

    def test_unknown_version_triggers_hard_gate(self):
        component = {
            "purl": "pkg:npm/jquery@?",
            "version": None,
            "loaded_on_pages": ["/"],
        }
        vuln = {"canonical_id": "CVE-2019-11358"}
        edge = correlate_component_vuln(component, vuln)
        assert edge.hard_negative is True
        assert edge.confidence == "unlikely"


# ---------------------------------------------------------------------------
# Component-Vulnerability correlation tests
# ---------------------------------------------------------------------------

class TestCorrelateComponentVuln:
    """Tests for component→vulnerability correlation."""

    def test_exact_purl_match_high_score(self):
        component = {
            "purl": "pkg:npm/jquery@1.9.0",
            "version": "1.9.0",
            "loaded_on_pages": ["/account"],
            "detection_evidence": [{"source": "source_map", "has_version": True}],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "affected_packages": ["pkg:npm/jquery@1.9.0"],
        }
        edge = correlate_component_vuln(
            component, vuln,
            in_scope_pages=["/account", "/checkout"],
        )
        # +0.40 purl match
        # +0.15 loaded on in-scope page
        # +0.00 kev (no kev info)
        # -0.00 no penalties
        # = 0.55
        assert edge.score >= 0.50
        assert edge.confidence in ("probable", "certain")
        assert edge.edge_type == EDGE_COMPONENT_AFFECTED

    def test_no_purl_match_zero_score(self):
        component = {
            "purl": "pkg:npm/lodash@4.17.20",
            "version": "4.17.20",
            "loaded_on_pages": ["/"],
            "detection_evidence": [],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "affected_packages": ["pkg:npm/jquery"],
        }
        edge = correlate_component_vuln(component, vuln)
        assert edge.score < 0.20
        assert edge.confidence in ("possible", "unlikely")

    def test_kev_boosts_score(self):
        component = {
            "purl": "pkg:npm/jquery@1.9.0",
            "version": "1.9.0",
            "loaded_on_pages": ["/"],
            "detection_evidence": [],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "affected_packages": ["pkg:npm/jquery@1.9.0"],
            "kev": True,
            "epss": 0.8,
            "cvss": 9.0,
        }
        edge = correlate_component_vuln(component, vuln)
        # +0.40 purl match
        # +0.30 KEV+epss+cvss enrichment (capped)
        # = 0.70 → certain
        assert edge.score >= 0.65
        assert edge.confidence == "certain"

    def test_filename_only_version_penalty(self):
        component = {
            "purl": "pkg:npm/jquery@1.9.0",
            "version": "1.9.0",
            "loaded_on_pages": ["/"],
            "detection_evidence": [
                {"source": "wappalyzer", "has_version": True},
            ],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "affected_packages": ["pkg:npm/jquery@1.9.0"],
        }
        edge = correlate_component_vuln(component, vuln)
        # +0.40 - 0.10 = 0.30
        assert 0.20 <= edge.score <= 0.40

    def test_edge_id_format(self):
        component = {"purl": "pkg:npm/jquery@1.9.0", "version": "1.9.0", "detection_evidence": []}
        vuln = {"canonical_id": "CVE-2019-11358", "affected_packages": ["pkg:npm/jquery@1.9.0"]}
        edge = correlate_component_vuln(component, vuln)
        assert edge.edge_id == "edge:pkg:npm/jquery@1.9.0->CVE-2019-11358"
        assert edge.from_id == "pkg:npm/jquery@1.9.0"
        assert edge.to_id == "CVE-2019-11358"


# ---------------------------------------------------------------------------
# SAST-Vulnerability correlation tests
# ---------------------------------------------------------------------------

class TestCorrelateSastToVuln:
    """Tests for SAST finding→vulnerability correlation."""

    def test_first_party_with_vulnerable_symbol_high_score(self):
        finding = {
            "finding_id": "f-001",
            "file": "app.js",
            "vuln_class": "prototype_pollution",
            "symbols": ["$.extend"],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend", "jQuery.extend"],
            "summary": "XSS via Object.prototype pollution in jQuery $.extend()",
        }
        edge = correlate_sast_to_vuln(
            finding, vuln,
            file_classification="first_party",
            source_map_present=False,
        )
        # +0.20 symbol appears
        # +0.30 first-party invokes vulnerable symbol
        # = 0.50
        assert edge.score >= 0.40
        assert edge.confidence in ("probable", "certain")
        assert edge.edge_type == EDGE_APP_INVOKES

    def test_third_party_component_correlation(self):
        finding = {
            "finding_id": "f-002",
            "file": "jquery-1.9.0.min.js",
            "vuln_class": "prototype_pollution",
            "symbols": ["$.extend"],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend"],
            "summary": "XSS via Object.prototype pollution in jQuery $.extend()",
        }
        edge = correlate_sast_to_vuln(
            finding, vuln,
            file_classification="single_component",
            source_map_present=False,
        )
        # +0.20 symbol appears
        # -0.20 vuln symbol only in library (not first-party)
        # = 0.0
        # But it's still an edge between sast_in_component and the vuln
        assert edge.edge_type == EDGE_SAST_IN_COMPONENT

    def test_vuln_class_only_match_capped_at_possible(self):
        finding = {
            "finding_id": "f-003",
            "file": "app.js",
            "vuln_class": "xss",
            "symbols": [],
        }
        vuln = {
            "canonical_id": "CVE-2020-0001",
            "vulnerable_symbols": [],
            "summary": "XSS vulnerability in web application",
        }
        edge = correlate_sast_to_vuln(
            finding, vuln,
            file_classification="first_party",
            source_map_present=False,
        )
        # The summary says "XSS" matching vuln_class, but no specific API
        # should be capped at "possible" per hard gate
        assert edge.confidence == "possible"

    def test_multi_component_bundle_with_source_map(self):
        finding = {
            "finding_id": "f-004",
            "file": "vendor.js",
            "vuln_class": "xss",
            "symbols": ["$.extend"],
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend"],
            "summary": "XSS via Object.prototype pollution in jQuery $.extend()",
        }
        edge = correlate_sast_to_vuln(
            finding, vuln,
            file_classification="multi_component_bundle",
            source_map_present=True,
        )
        # +0.20 symbol appears (no first-party bonus)
        # -0.15 vendor bundle penalty (no source map bonus either)
        # = 0.05
        assert edge.score < 0.20

    def test_tainted_flow_boosts(self):
        finding = {
            "finding_id": "f-005",
            "file": "app.js",
            "vuln_class": "prototype_pollution",
            "symbols": ["$.extend"],
            "taint_flow": "userInput -> JSON.parse -> $.extend",
        }
        vuln = {
            "canonical_id": "CVE-2019-11358",
            "vulnerable_symbols": ["$.extend"],
            "summary": "XSS via Object.prototype pollution in jQuery $.extend()",
        }
        edge = correlate_sast_to_vuln(
            finding, vuln,
            file_classification="first_party",
            source_map_present=False,
        )
        # +0.20 symbol appears
        # +0.30 first-party invokes
        # +0.25 tainted source reaches
        # = 0.75
        assert edge.score >= 0.60
        assert edge.confidence in ("probable", "certain")


# ---------------------------------------------------------------------------
# Agent candidate selection tests
# ---------------------------------------------------------------------------

class TestSelectAgentCandidates:
    """Tests for filtering edges that need agent review."""

    def test_excludes_hard_negatives(self):
        edges = [
            CorrelationEdge(
                edge_id="e1",
                edge_type=EDGE_COMPONENT_AFFECTED,
                from_id="a",
                to_id="b",
                score=0.5,
                hard_negative=True,
            )
        ]
        candidates = select_agent_candidates(edges)
        assert candidates == []

    def test_ambiguous_range_included(self):
        edges = [
            CorrelationEdge(
                edge_id="e1",
                edge_type=EDGE_COMPONENT_AFFECTED,
                from_id="a",
                to_id="b",
                score=0.55,  # in 0.45-0.85 range
                confidence="probable",
            )
        ]
        candidates = select_agent_candidates(edges)
        assert len(candidates) == 1

    def test_high_score_excluded(self):
        # score > 0.85 → not ambiguous
        edges = [
            CorrelationEdge(
                edge_id="e1",
                edge_type=EDGE_COMPONENT_AFFECTED,
                from_id="a",
                to_id="b",
                score=0.95,
                confidence="certain",
            )
        ]
        candidates = select_agent_candidates(edges)
        assert candidates == []

    def test_unlikely_excluded(self):
        edges = [
            CorrelationEdge(
                edge_id="e1",
                edge_type=EDGE_COMPONENT_AFFECTED,
                from_id="a",
                to_id="b",
                score=0.1,
                confidence="unlikely",
            )
        ]
        candidates = select_agent_candidates(edges)
        assert candidates == []

    def test_empty_input(self):
        assert select_agent_candidates([]) == []


# ---------------------------------------------------------------------------
# Serialization tests
# ---------------------------------------------------------------------------

class TestEdgesToDicts:
    """Tests for edges_to_dicts serialization."""

    def test_serialize_basic(self):
        e = CorrelationEdge(
            edge_id="e1",
            edge_type=EDGE_COMPONENT_AFFECTED,
            from_id="a",
            to_id="b",
            confidence="probable",
            score=0.55,
            evidence=[{"type": "purl_match"}],
            reason="test",
        )
        d = edges_to_dicts([e])[0]
        assert d["edge_id"] == "e1"
        assert d["edge_type"] == EDGE_COMPONENT_AFFECTED
        assert d["from_id"] == "a"
        assert d["to_id"] == "b"
        assert d["confidence"] == "probable"
        assert d["score"] == 0.55
        assert d["evidence"] == [{"type": "purl_match"}]
        assert d["reason"] == "test"
        assert d["hard_negative"] is False
