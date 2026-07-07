"""Tests for Joern integration (joern_integration.py).

These tests verify the graceful degradation behavior when Joern is not
installed (which is the common case on dev machines). They also test
query template construction without actually running Joern.
"""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import joern_integration


class TestJoernAvailability:
    """Test the availability detection and graceful degradation."""

    def test_is_joern_available_returns_bool(self):
        """Should return bool, never raise."""
        result = joern_integration.is_joern_available()
        assert isinstance(result, bool)

    def test_reset_availability_cache(self):
        """Cache reset should be safe to call."""
        joern_integration.reset_availability_cache()
        joern_integration.reset_availability_cache()  # Multiple calls OK

    def test_warn_joern_unavailable_returns_string(self):
        """Warning message should be returned as a string."""
        msg = joern_integration.warn_joern_unavailable()
        assert isinstance(msg, str)
        assert "Joern" in msg
        assert "install" in msg.lower() or "Install" in msg


class TestParseCGP:
    """Test CPG building (graceful degradation when Joern unavailable)."""

    def test_parse_cpg_returns_false_when_joern_unavailable(self, tmp_path):
        """If Joern isn't installed, parse_cpg returns False (no exception)."""
        # Even if tmp_path has no JS files, the function should return False
        # rather than raising if Joern is unavailable
        result = joern_integration.parse_cpg(tmp_path, jvm_heap="1G", timeout=5)
        # On a machine without Joern, this returns False
        if not joern_integration.is_joern_available():
            assert result is False
        # If Joern IS available, it might succeed or fail based on input

    def test_parse_cpg_handles_invalid_path(self):
        """Invalid paths should not raise — return False."""
        result = joern_integration.parse_cpg(
            "/nonexistent/path/that/does/not/exist",
            jvm_heap="1G",
            timeout=5,
        )
        if not joern_integration.is_joern_available():
            assert result is False


class TestRunDataflowQueries:
    """Test data flow query execution."""

    def test_returns_empty_when_joern_unavailable(self, tmp_path):
        """Empty list when Joern isn't installed."""
        queries = [
            joern_integration.JoernQuery(name="test", scala_script="x")
        ]
        result = joern_integration.run_dataflow_queries(tmp_path, queries, jvm_heap="1G")
        if not joern_integration.is_joern_available():
            assert result == []


class TestJoernQuery:
    """Test the JoernQuery dataclass."""

    def test_query_construction(self):
        q = joern_integration.JoernQuery(
            name="test_query",
            scala_script="importCpg('x'); cpg.call.toJson",
            sources=["user_input"],
            sinks=["dangerous_func"],
        )
        assert q.name == "test_query"
        assert "importCpg" in q.scala_script
        assert q.sources == ["user_input"]
        assert q.sinks == ["dangerous_func"]


class TestBuiltinQueryTemplates:
    """Test that built-in query templates exist and are well-formed."""

    @pytest.mark.parametrize("vuln_class", [
        "dom_xss",
        "prototype_pollution",
        "command_injection",
        "ssrf",
        "sqli",
    ])
    def test_builtin_template_exists(self, vuln_class):
        q = joern_integration.joern_query(vuln_class)
        assert q is not None, f"No template for {vuln_class}"
        assert q.name == vuln_class
        assert q.scala_script
        # Should reference CPG loading
        assert "importCpg" in q.scala_script
        # Should reference reachableByFlows (data flow analysis)
        assert "reachableByFlows" in q.scala_script

    def test_joern_query_unknown_returns_none(self):
        assert joern_integration.joern_query("nonexistent_vuln") is None

    def test_dom_xss_template_has_innerHTML_sink(self):
        q = joern_integration.joern_query("dom_xss")
        # innerHTML should be in the sink regex
        assert "innerHTML" in q.scala_script
        # eval should also be a sink
        assert "eval" in q.scala_script

    def test_prototype_pollution_has_assign_sink(self):
        q = joern_integration.joern_query("prototype_pollution")
        # Object.assign is a common proto pollution vector
        assert "Object" in q.scala_script or "assign" in q.scala_script

    def test_all_templates_have_sources(self):
        """Each template should define at least one source pattern."""
        for vuln_class in ["dom_xss", "prototype_pollution", "command_injection", "ssrf", "sqli"]:
            q = joern_integration.joern_query(vuln_class)
            assert q.sources, f"{vuln_class} has no sources"
            assert q.sinks, f"{vuln_class} has no sinks"


class TestIsJoernSuitable:
    """Test the file suitability check for Joern analysis."""

    def test_first_party_js_suitable(self):
        assert joern_integration.is_joern_suitable("app.js") is True

    def test_node_modules_not_suitable(self):
        """node_modules files should be skipped (libraries, not novel code)."""
        assert joern_integration.is_joern_suitable(
            "/path/to/node_modules/react/index.js"
        ) is False

    def test_html_files_not_suitable(self):
        assert joern_integration.is_joern_suitable("page.html") is False
        assert joern_integration.is_joern_suitable("style.css") is False

    def test_js_files_suitable(self):
        assert joern_integration.is_joern_suitable("app.js") is True
        assert joern_integration.is_joern_suitable("module.mjs") is True
        assert joern_integration.is_joern_suitable("common.cjs") is True
        assert joern_integration.is_joern_suitable("component.tsx") is True
        assert joern_integration.is_joern_suitable("app.ts") is True

    def test_cdn_bundle_not_suitable(self):
        """CDN bundles are well-known libraries; skip Joern."""

        class FakeCls:
            classification = "cdn_bundle"

        assert joern_integration.is_joern_suitable(
            "jquery.min.js", classification=FakeCls()
        ) is False

    def test_multi_component_bundle_without_sourcemap_not_suitable(self):
        """Multi-component bundles need source maps to deobfuscate first."""

        class FakeCls:
            classification = "multi_component_bundle"

        assert joern_integration.is_joern_suitable(
            "bundle.js", classification=FakeCls(), source_map_url=None
        ) is False

    def test_multi_component_bundle_with_sourcemap_suitable(self):
        """If source map is present, deobfuscation can run first."""

        class FakeCls:
            classification = "multi_component_bundle"

        assert joern_integration.is_joern_suitable(
            "bundle.js",
            classification=FakeCls(),
            source_map_url="https://cdn.example.com/bundle.js.map",
        ) is True

    def test_inline_script_not_suitable(self):
        """Inline scripts are too small for AST value."""

        class FakeCls:
            classification = "inline"

        assert joern_integration.is_joern_suitable(
            "_inline_1.js", classification=FakeCls()
        ) is False

    def test_first_party_classification_suitable(self):
        """First-party files are always suitable."""

        class FakeCls:
            classification = "first_party"

        assert joern_integration.is_joern_suitable(
            "src/app.js", classification=FakeCls()
        ) is True


class TestDataFlowSlice:
    """Test the DataFlowSlice dataclass."""

    def test_defaults(self):
        s = joern_integration.DataFlowSlice()
        assert s.nodes == []
        assert s.edges == []
        assert s.file == ""
        assert s.vuln_class == ""

    def test_with_data(self):
        s = joern_integration.DataFlowSlice(
            nodes=[{"id": 1, "label": "call", "code": "x()"}],
            edges=[{"src": 1, "dst": 2, "label": "REACHING_DEF"}],
            file="app.js",
            vuln_class="dom_xss",
        )
        assert len(s.nodes) == 1
        assert len(s.edges) == 1
        assert s.file == "app.js"


class TestJoernResult:
    """Test the JoernResult dataclass."""

    def test_defaults(self):
        r = joern_integration.JoernResult()
        assert r.available is False
        assert r.slices == []
        assert r.error is None
        assert r.cpg_path is None
        assert r.duration_seconds == 0.0
        assert r.queries_run == 0

    def test_graceful_degradation_result(self):
        """When Joern is unavailable, result should have available=False."""
        if not joern_integration.is_joern_available():
            r = joern_integration.JoernResult(available=False, error="not installed")
            assert r.available is False
            assert r.error == "not installed"


class TestRunJoernForFiles:
    """High-level convenience function."""

    def test_returns_result_when_joern_unavailable(self, tmp_path):
        """If Joern not installed, returns result with available=False."""
        f = tmp_path / "test.js"
        f.write_text("var x = 1;")
        result = joern_integration.run_joern_for_files(
            [f],
            vuln_classes=["dom_xss"],
        )
        if not joern_integration.is_joern_available():
            assert result.available is False
            assert result.error is not None
            assert result.slices == []
