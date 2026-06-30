"""
Tests for dedup_components.py — Component normalization and deduplication.
"""

import sys
from pathlib import Path

# Ensure scripts directory is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from dedup_components import (
    Component,
    dedup_components,
    components_to_dicts,
    _derive_ecosystem_from_purl,
    _derive_name_from_purl,
    _derive_confidence,
)


# ---------------------------------------------------------------------------
# Helper function tests
# ---------------------------------------------------------------------------

class TestDeriveEcosystemFromPurl:
    """Tests for purl ecosystem extraction."""

    def test_npm(self):
        assert _derive_ecosystem_from_purl("pkg:npm/jquery@1.9.0") == "npm"

    def test_cdnjs(self):
        assert _derive_ecosystem_from_purl("pkg:cdn/cdnjs/jquery@1.9.0") == "cdnjs"

    def test_jsdelivr(self):
        assert _derive_ecosystem_from_purl("pkg:cdn/jsdelivr/jquery@1.9.0") == "jsdelivr"

    def test_github(self):
        assert _derive_ecosystem_from_purl("pkg:github/jquery/jquery@1.9.0") == "github"

    def test_generic(self):
        assert _derive_ecosystem_from_purl("pkg:generic/mylib@1.0") == "generic"

    def test_invalid(self):
        assert _derive_ecosystem_from_purl("not-a-purl") == ""
        assert _derive_ecosystem_from_purl("") == ""


class TestDeriveNameFromPurl:
    """Tests for purl name extraction."""

    def test_npm_simple(self):
        assert _derive_name_from_purl("pkg:npm/jquery@1.9.0") == "jquery@1.9.0"

    def test_npm_no_version(self):
        assert _derive_name_from_purl("pkg:npm/jquery") == "jquery"

    def test_cdnjs(self):
        assert _derive_name_from_purl("pkg:cdn/cdnjs/jquery@1.9.0") == "jquery@1.9.0"

    def test_github(self):
        assert _derive_name_from_purl("pkg:github/jquery/jquery@1.9.0") == "jquery@1.9.0"


class TestDeriveConfidence:
    """Tests for confidence derivation from evidence."""

    def test_certain_multi_source_with_version(self):
        evidence = [
            {"source": "wappalyzer", "has_version": True},
            {"source": "source_map", "has_version": True},
        ]
        assert _derive_confidence(evidence) == "certain"

    def test_probable_single_source_with_version(self):
        evidence = [{"source": "wappalyzer", "has_version": True}]
        assert _derive_confidence(evidence) == "probable"

    def test_possible_no_version(self):
        evidence = [{"source": "wappalyzer", "has_version": False}]
        assert _derive_confidence(evidence) == "possible"

    def test_certain_three_sources(self):
        evidence = [
            {"source": "wappalyzer", "has_version": True},
            {"source": "source_map", "has_version": True},
            {"source": "runtime_probe", "has_version": True},
        ]
        assert _derive_confidence(evidence) == "certain"

    def test_probable_two_sources_no_version(self):
        # Two sources agree but no version
        evidence = [
            {"source": "wappalyzer", "has_version": False},
            {"source": "content", "has_version": False},
        ]
        assert _derive_confidence(evidence) == "possible"

    def test_empty_evidence(self):
        assert _derive_confidence([]) == "possible"


# ---------------------------------------------------------------------------
# dedup_components tests
# ---------------------------------------------------------------------------

class TestDedupComponents:
    """Tests for the main dedup_components entry point."""

    def test_single_component_with_version(self):
        tech_stack = {"jQuery": ["jquery-1.9.0.min.js"]}
        versions = {"jQuery": "1.9.0"}
        purls = {"jQuery": "pkg:npm/jquery@1.9.0"}
        details = [
            {"technology": "jQuery", "file": "jquery-1.9.0.min.js",
             "vector": "scriptSrc", "version": "1.9.0", "confidence": "high"}
        ]
        result = dedup_components(tech_stack, versions, purls, details)
        assert len(result) == 1
        c = result[0]
        assert c.purl == "pkg:npm/jquery@1.9.0"
        assert c.name == "jquery@1.9.0"
        assert c.ecosystem == "npm"
        assert c.version == "1.9.0"
        assert c.display_name == "jQuery"
        assert c.files == ["jquery-1.9.0.min.js"]
        assert c.detection_confidence == "probable"  # single source, has version
        assert "scriptSrc" in c.detectors

    def test_multi_source_evidence_promotes_to_certain(self):
        tech_stack = {"jQuery": ["jquery-1.9.0.min.js"]}
        versions = {"jQuery": "1.9.0"}
        purls = {"jQuery": "pkg:npm/jquery@1.9.0"}
        details = [
            {"technology": "jQuery", "file": "jquery-1.9.0.min.js",
             "vector": "scriptSrc", "version": "1.9.0"},
            {"technology": "jQuery", "file": "jquery-1.9.0.min.js",
             "vector": "sourceMap", "version": "1.9.0"},
        ]
        result = dedup_components(tech_stack, versions, purls, details)
        assert result[0].detection_confidence == "certain"
        assert set(result[0].detectors) == {"scriptSrc", "sourceMap"}

    def test_multiple_files_deduplicated(self):
        tech_stack = {"jQuery": ["jquery-1.9.0.min.js", "jquery-1.9.0.min.js", "app.js"]}
        versions = {"jQuery": "1.9.0"}
        purls = {"jQuery": "pkg:npm/jquery@1.9.0"}
        details = []
        result = dedup_components(tech_stack, versions, purls, details)
        # Files should be deduplicated but preserve order
        assert result[0].files == ["jquery-1.9.0.min.js", "app.js"]

    def test_loaded_on_pages_attached(self):
        tech_stack = {"jQuery": ["jquery-1.9.0.min.js"]}
        versions = {"jQuery": "1.9.0"}
        purls = {"jQuery": "pkg:npm/jquery@1.9.0"}
        details = []
        pages = {"jQuery": ["/account", "/checkout"]}
        result = dedup_components(tech_stack, versions, purls, details, pages)
        assert result[0].loaded_on_pages == ["/account", "/checkout"]

    def test_skip_libraries_without_purl(self):
        tech_stack = {"jQuery": ["jquery.js"], "UnknownLib": ["x.js"]}
        versions = {"jQuery": "1.9.0", "UnknownLib": "1.0"}
        purls = {"jQuery": "pkg:npm/jquery@1.9.0"}  # UnknownLib has no purl
        details = []
        result = dedup_components(tech_stack, versions, purls, details)
        assert len(result) == 1
        assert result[0].display_name == "jQuery"

    def test_cdnjs_ecosystem_detected(self):
        tech_stack = {"jQuery": ["jquery-1.9.0.min.js"]}
        versions = {"jQuery": "1.9.0"}
        purls = {"jQuery": "pkg:cdn/cdnjs/jquery@1.9.0"}
        details = []
        result = dedup_components(tech_stack, versions, purls, details)
        assert result[0].ecosystem == "cdnjs"
        assert result[0].purl == "pkg:cdn/cdnjs/jquery@1.9.0"

    def test_empty_inputs(self):
        result = dedup_components({}, {}, {}, [])
        assert result == []

    def test_multiple_libraries(self):
        tech_stack = {
            "jQuery": ["jquery-1.9.0.min.js"],
            "Lodash": ["lodash.min.js"],
            "Vue.js": ["vue.min.js"],
        }
        versions = {"jQuery": "1.9.0", "Lodash": "4.17.20", "Vue.js": "3.4.0"}
        purls = {
            "jQuery": "pkg:npm/jquery@1.9.0",
            "Lodash": "pkg:npm/lodash@4.17.20",
            "Vue.js": "pkg:npm/vue.js@3.4.0",
        }
        details = []
        result = dedup_components(tech_stack, versions, purls, details)
        assert len(result) == 3
        # All should have version info
        for c in result:
            assert c.version is not None
            assert c.purl != ""


# ---------------------------------------------------------------------------
# Serialization tests
# ---------------------------------------------------------------------------

class TestComponentsToDicts:
    """Tests for components_to_dicts serialization."""

    def test_serialize_basic(self):
        c = Component(
            purl="pkg:npm/jquery@1.9.0",
            name="jquery@1.9.0",
            display_name="jQuery",
            version="1.9.0",
            ecosystem="npm",
            files=["jquery.min.js"],
            detection_confidence="certain",
        )
        d = components_to_dicts([c])[0]
        assert d["purl"] == "pkg:npm/jquery@1.9.0"
        assert d["name"] == "jquery@1.9.0"
        assert d["display_name"] == "jQuery"
        assert d["version"] == "1.9.0"
        assert d["ecosystem"] == "npm"
        assert d["files"] == ["jquery.min.js"]
        assert d["detection_confidence"] == "certain"
        assert d["detection_evidence"] == []
        assert d["detectors"] == []

    def test_serialize_with_evidence(self):
        c = Component(
            purl="pkg:npm/jquery@1.9.0",
            display_name="jQuery",
            detection_evidence=[
                {"source": "wappalyzer", "has_version": True, "file": "jquery.js"}
            ],
            detectors=["wappalyzer"],
        )
        d = components_to_dicts([c])[0]
        assert d["detectors"] == ["wappalyzer"]
        assert d["detection_evidence"][0]["source"] == "wappalyzer"
