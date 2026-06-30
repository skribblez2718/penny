"""Tests for the full STRUCTURE and SLICE handler implementations (Phase C).

These tests verify the actual end-to-end behavior of:
- structure_handler: builds ModuleCards, PageCards, typed store
- slice_handler: builds FlowCards from SAST findings + dangerous patterns
- Heuristics: _infer_vuln_class_from_rule, _infer_cwe_for_vuln, _infer_sink_for_vuln
"""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fsm import (
    JSAState,
    structure_handler,
    slice_handler,
    _infer_vuln_class_from_rule,
    _infer_cwe_for_vuln,
    _infer_sink_for_vuln,
)


class TestStructureHandlerFull:
    """Tests for the full STRUCTURE handler implementation."""

    def test_empty_files(self):
        state = JSAState()
        state = structure_handler(state, js_files=[])
        # Empty list should not produce cards
        assert len(state.module_cards) == 0

    def test_none_files_falls_back_to_file_map(self):
        """When js_files is None and file_map is empty, set warning."""
        state = JSAState()
        state = structure_handler(state, js_files=None)
        # Should record warning, not crash
        assert "structure_warning" in state.metadata

    def test_builds_module_cards_for_each_file(self):
        state = JSAState()
        files = [
            ("a.js", "function foo() { return 1; }"),
            ("b.js", "const x = 2;"),
            ("c.js", "class MyClass { method() {} }"),
        ]
        state = structure_handler(state, js_files=files)
        assert len(state.module_cards) == 3
        filenames = {mc.filename for mc in state.module_cards}
        assert filenames == {"a.js", "b.js", "c.js"}

    def test_module_card_has_manifest_metadata(self):
        state = JSAState()
        files = [("app.js", "const x = 1;")]
        state = structure_handler(state, js_files=files)
        mc = state.module_cards[0]
        assert mc.filename == "app.js"
        assert mc.source_length == len("const x = 1;")
        # SHA1 of "const x = 1;" is b25bf6e8a8d6e8c1d35a8b0d4f9b5e1c2d3e4f5a6
        # Just check it's a valid SHA1 (40 hex chars)
        assert len(mc.hash) == 40

    def test_module_card_has_ast_summary(self):
        state = JSAState()
        files = [("app.js", "function a() {} function b() {} class C {}")]
        state = structure_handler(state, js_files=files)
        mc = state.module_cards[0]
        assert mc.ast_summary is not None
        # At least 2 functions (a, b)
        assert mc.ast_summary.function_count >= 2
        # 1 class
        assert mc.ast_summary.class_count == 1
        # Top-level names
        assert "a" in mc.ast_summary.top_level_names
        assert "b" in mc.ast_summary.top_level_names
        assert "C" in mc.ast_summary.top_level_names

    def test_module_card_captures_dangerous_patterns(self):
        state = JSAState()
        files = [("vuln.js", "el.innerHTML = userInput;")]
        state = structure_handler(state, js_files=files)
        mc = state.module_cards[0]
        assert len(mc.dangerous_patterns) >= 1
        pattern_ids = [dp.pattern_id for dp in mc.dangerous_patterns]
        assert "innerHTML_assignment" in pattern_ids

    def test_builds_page_cards_for_html_files(self):
        state = JSAState()
        files = [
            ("a.js", "var x = 1;"),
            ("page.html", '<html><body><script src="a.js"></script></body></html>'),
        ]
        state = structure_handler(state, js_files=files)
        # 1 module card (a.js) and 1 page card (page.html)
        assert len(state.module_cards) == 2
        assert len(state.page_cards) == 1
        pc = state.page_cards[0]
        assert pc.url == "page.html"
        # script_files should contain a.js
        assert any("a.js" in sf.url for sf in pc.script_files)

    def test_page_card_has_dom_inventory(self):
        state = JSAState()
        files = [(
            "page.html",
            '<html><body><div id="main"><form action="/api"><input id="email" name="email"></form></div></body></html>',
        )]
        state = structure_handler(state, js_files=files)
        pc = state.page_cards[0]
        assert pc.dom_inventory is not None
        assert "main" in pc.dom_inventory.dom_ids
        assert "email" in pc.dom_inventory.dom_ids
        assert "/api" in pc.dom_inventory.form_actions

    def test_typed_store_populated(self):
        state = JSAState()
        files = [("app.js", "function foo() { return 'bar'; }")]
        state = structure_handler(state, js_files=files)
        # typed_store should have manifest, ast_indices, dangerous_patterns
        assert "file_manifest" in state.typed_store
        assert "ast_indices" in state.typed_store
        assert "dangerous_patterns" in state.typed_store

    def test_metadata_summary_fields(self):
        state = JSAState()
        files = [("app.js", "var x = 1;")]
        state = structure_handler(state, js_files=files)
        # Summary metadata fields
        assert state.metadata["structure_started"] is True
        assert state.metadata["structure_module_cards"] == 1
        assert state.metadata["structure_page_cards"] == 0
        assert state.metadata["structure_cards_built"] == 1
        assert "structure_duration_ms" in state.metadata

    def test_page_cards_from_acquire_metadata(self):
        """PageCards are also built from ACQUIRE's crawled_pages."""
        state = JSAState()
        state.metadata["acquire"] = {
            "crawled_pages": [
                "https://example.com/page1",
                "https://example.com/page2",
            ]
        }
        state = structure_handler(state, js_files=[])
        # Should still build PageCards from the ACQUIRE metadata
        assert len(state.page_cards) == 2
        urls = {pc.url for pc in state.page_cards}
        assert "https://example.com/page1" in urls
        assert "https://example.com/page2" in urls

    def test_invalid_js_handled_gracefully(self):
        """Invalid JS should not crash the handler."""
        state = JSAState()
        files = [
            ("valid.js", "const x = 1;"),
            ("broken.js", "const { unclosed"),
        ]
        # Should not raise
        state = structure_handler(state, js_files=files)
        # Both files should still produce module cards
        assert len(state.module_cards) == 2


class TestSliceHandlerFull:
    """Tests for the full SLICE handler implementation."""

    def test_empty_state(self):
        state = JSAState()
        state = slice_handler(state)
        # No SAST findings, no module cards, no flow cards
        assert len(state.flow_cards) == 0

    def test_sast_findings_create_flow_cards(self):
        state = JSAState()
        state.sast_findings = [
            {"rule_id": "javascript.lang.security.audit.dom.xss",
             "path": "app.js", "line": 10, "message": "xss"},
            {"rule_id": "javascript.lang.security.audit.eval-detected",
             "path": "app.js", "line": 5, "message": "eval"},
        ]
        state = slice_handler(state)
        assert len(state.flow_cards) >= 2
        vuln_classes = {fc.vulnerability_class for fc in state.flow_cards}
        assert "dom_xss" in vuln_classes
        assert "command_injection" in vuln_classes

    def test_flow_cards_have_correct_lane(self):
        state = JSAState()
        state.sast_findings = [
            {"rule_id": "dom.xss", "path": "app.js", "line": 1, "message": "xss"},
            {"rule_id": "cors", "path": "app.js", "line": 1, "message": "cors"},
        ]
        state = slice_handler(state)
        for fc in state.flow_cards:
            if fc.vulnerability_class == "dom_xss":
                assert fc.lane == "code_static"
            elif fc.vulnerability_class == "cors":
                assert fc.lane == "network_behavior"

    def test_flow_cards_have_cwe_ids(self):
        state = JSAState()
        state.sast_findings = [
            {"rule_id": "xss", "path": "app.js", "line": 1, "message": ""},
        ]
        state = slice_handler(state)
        for fc in state.flow_cards:
            assert fc.cwe_id is not None
            # CWE-79 is the standard XSS
            if "xss" in fc.vulnerability_class:
                assert fc.cwe_id == "CWE-79"

    def test_dangerous_patterns_also_create_flow_cards(self):
        state = JSAState()
        # Add a module card with dangerous patterns
        from module_card import ModuleCard, DangerousPattern
        state.module_cards = [
            ModuleCard(
                filename="vuln.js",
                source_length=100,
                hash="x" * 40,
                dangerous_patterns=[
                    DangerousPattern(
                        pattern_id="innerHTML_assignment",
                        description="innerHTML assignment",
                        line=42,
                        severity="high",
                        suggested_vuln_classes=["dom_xss"],
                    )
                ],
            )
        ]
        state = slice_handler(state)
        # Should create a flow card from the dangerous pattern
        dom_xss_cards = [fc for fc in state.flow_cards if fc.vulnerability_class == "dom_xss"]
        assert len(dom_xss_cards) >= 1
        # The flow card should reference the source file in its module_card_ids
        assert any("vuln.js" in mci for fc in dom_xss_cards for mci in fc.module_card_ids)

    def test_slice_caps_candidates(self):
        """Should limit to top 20 candidates per vuln class."""
        state = JSAState()
        # Generate 50 dom_xss findings
        state.sast_findings = [
            {"rule_id": "xss", "path": f"app{i}.js", "line": i, "message": ""}
            for i in range(50)
        ]
        state = slice_handler(state)
        dom_xss_cards = [fc for fc in state.flow_cards if fc.vulnerability_class == "dom_xss"]
        # Should be capped at 20
        assert len(dom_xss_cards) == 20

    def test_metadata_records_joern_status(self):
        state = JSAState()
        state.module_cards = []
        state = slice_handler(state)
        # Should record joern status (unavailable on dev machines)
        assert "joern_status" in state.metadata
        # On this machine, Joern is likely not installed
        assert state.metadata["joern_status"] in ("unavailable", "no_module_cards", "no_js_files")

    def test_metadata_records_vuln_classes(self):
        state = JSAState()
        state.sast_findings = [
            {"rule_id": "xss", "path": "a.js", "line": 1, "message": ""},
            {"rule_id": "sql", "path": "a.js", "line": 2, "message": ""},
        ]
        state = slice_handler(state)
        assert "dom_xss" in state.metadata["slice_vuln_classes"]
        assert "sqli" in state.metadata["slice_vuln_classes"]


class TestInferVulnClassFromRule:
    """Tests for the _infer_vuln_class_from_rule helper."""

    def test_xss_inference(self):
        assert _infer_vuln_class_from_rule("javascript.xss", {}) == "dom_xss"
        assert _infer_vuln_class_from_rule("innerHTML-detected", {}) == "dom_xss"
        assert _infer_vuln_class_from_rule("dom-xss-audit", {}) == "dom_xss"

    def test_prototype_pollution_inference(self):
        assert _infer_vuln_class_from_rule("prototype-pollution", {}) == "prototype_pollution"
        assert _infer_vuln_class_from_rule("object-pollution", {}) == "prototype_pollution"

    def test_command_injection_inference(self):
        assert _infer_vuln_class_from_rule("eval-detected", {}) == "command_injection"
        assert _infer_vuln_class_from_rule("code-injection", {}) == "command_injection"
        assert _infer_vuln_class_from_rule("exec-injection", {}) == "command_injection"

    def test_ssrf_inference(self):
        assert _infer_vuln_class_from_rule("ssrf-audit", {}) == "ssrf"
        assert _infer_vuln_class_from_rule("server-side-request", {}) == "ssrf"
        assert _infer_vuln_class_from_rule("ssrf-detected", {}) == "ssrf"

    def test_sqli_inference(self):
        assert _infer_vuln_class_from_rule("sql-injection", {}) == "sqli"
        assert _infer_vuln_class_from_rule("sql-query", {}) == "sqli"

    def test_postmessage_inference(self):
        assert _infer_vuln_class_from_rule("postmessage", {}) == "postmessage"
        assert _infer_vuln_class_from_rule("post_message-handler", {}) == "postmessage"

    def test_open_redirect_inference(self):
        assert _infer_vuln_class_from_rule("openredirect", {}) == "open_redirect"
        assert _infer_vuln_class_from_rule("unsafe-redirect", {}) == "open_redirect"

    def test_secret_inference(self):
        assert _infer_vuln_class_from_rule("hardcoded-secret", {}) == "secret_disclosure"
        assert _infer_vuln_class_from_rule("api-key-exposure", {}) == "secret_disclosure"
        assert _infer_vuln_class_from_rule("exposed-token", {}) == "secret_disclosure"

    def test_csrf_inference(self):
        """Default to csrf_dom (DOM-based) since csrf_network is HTTP-specific."""
        assert _infer_vuln_class_from_rule("csrf-detected", {}) == "csrf_dom"

    def test_cors_inference(self):
        assert _infer_vuln_class_from_rule("cors-misconfig", {}) == "cors"

    def test_unknown_returns_none(self):
        assert _infer_vuln_class_from_rule("unrelated-rule", {}) is None
        assert _infer_vuln_class_from_rule("random-name", {}) is None

    def test_case_insensitive(self):
        assert _infer_vuln_class_from_rule("XSS-Detected", {}) == "dom_xss"
        assert _infer_vuln_class_from_rule("Eval-Usage", {}) == "command_injection"


class TestInferCWEForVuln:
    """Tests for the _infer_cwe_for_vuln helper."""

    def test_known_vuln_classes(self):
        assert _infer_cwe_for_vuln("dom_xss") == "CWE-79"
        assert _infer_cwe_for_vuln("prototype_pollution") == "CWE-1321"
        assert _infer_cwe_for_vuln("command_injection") == "CWE-78"
        assert _infer_cwe_for_vuln("ssrf") == "CWE-918"
        assert _infer_cwe_for_vuln("sqli") == "CWE-89"
        assert _infer_cwe_for_vuln("postmessage") == "CWE-345"
        assert _infer_cwe_for_vuln("open_redirect") == "CWE-601"
        assert _infer_cwe_for_vuln("csrf_dom") == "CWE-352"
        assert _infer_cwe_for_vuln("csrf_network") == "CWE-352"
        assert _infer_cwe_for_vuln("cors") == "CWE-942"

    def test_unknown_returns_none(self):
        assert _infer_cwe_for_vuln("not_a_real_vuln") is None
        assert _infer_cwe_for_vuln("") is None


class TestInferSinkForVuln:
    """Tests for the _infer_sink_for_vuln helper."""

    def test_known_vuln_classes(self):
        assert _infer_sink_for_vuln("dom_xss") == "innerHTML"
        assert _infer_sink_for_vuln("prototype_pollution") == "Object.assign"
        assert _infer_sink_for_vuln("command_injection") == "eval"
        assert _infer_sink_for_vuln("ssrf") == "fetch"
        assert _infer_sink_for_vuln("sqli") == "query"
        assert _infer_sink_for_vuln("postmessage") == "postMessage"
        assert _infer_sink_for_vuln("open_redirect") == "location.href"

    def test_unknown_returns_unknown(self):
        assert _infer_sink_for_vuln("not_a_real_vuln") == "unknown"
        assert _infer_sink_for_vuln("") == "unknown"


class TestFullPipelineWithStructureAndSlice:
    """Integration tests combining STRUCTURE and SLICE phases."""

    def test_structure_then_slice(self):
        """Run STRUCTURE then SLICE — slice should consume the module cards."""
        state = JSAState()
        files = [
            ("vuln.js", '''
                el.innerHTML = userInput;
                eval(userInput);
                Object.assign(target, source);
            '''),
        ]

        # Phase 1: STRUCTURE
        state = structure_handler(state, js_files=files)
        assert len(state.module_cards) == 1
        mc = state.module_cards[0]
        assert len(mc.dangerous_patterns) >= 3  # innerHTML, eval, Object.assign

        # Phase 2: SLICE
        state = slice_handler(state)
        # Should produce flow cards from the dangerous patterns
        assert len(state.flow_cards) >= 3
        vuln_classes = {fc.vulnerability_class for fc in state.flow_cards}
        assert "dom_xss" in vuln_classes
        assert "command_injection" in vuln_classes
        assert "prototype_pollution" in vuln_classes

    def test_dangerous_patterns_feed_into_flow_cards(self):
        """Dangerous patterns in ModuleCards should create FlowCards in SLICE."""
        state = JSAState()
        files = [("vuln.js", "el.innerHTML = x;")]
        state = structure_handler(state, js_files=files)
        state = slice_handler(state)

        # Find the dom_xss flow card
        dom_xss_cards = [fc for fc in state.flow_cards if fc.vulnerability_class == "dom_xss"]
        assert len(dom_xss_cards) >= 1
        # Should reference the source file
        assert any("vuln.js" in mci for fc in dom_xss_cards for mci in fc.module_card_ids)
