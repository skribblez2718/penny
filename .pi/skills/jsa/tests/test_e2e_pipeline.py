"""End-to-end integration test for the full jsa pipeline (Phase E).

Tests the entire flow: INTAKE → ACQUIRE → CVE_RESEARCH → SAST_SCAN →
NORMALIZE → DEDUP_WITHIN_SOURCE → CORRELATE_EVIDENCE → AGENT_REVIEW →
SAST_VALIDATE → STRUCTURE → SLICE → INVESTIGATE → COLLECT → MERGE →
VERIFY → REPORT → REFLECT → COMPLETED.

This test verifies:
1. All phases execute in order
2. The typed analysis store is properly built
3. PageCard, ModuleCard, FlowCard are produced at the right phases
4. INVESTIGATE produces per-lane work items
5. The final state has the expected metadata
"""

import sys
from pathlib import Path

import pytest

# Add the scripts directory to the path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fsm import JSAState, run_pipeline


# Test fixture: Vulnerable code patterns
VULNERABLE_DOM_XSS = """
// VULNERABLE: DOM XSS via innerHTML
function renderProfile(userName) {
    const profileEl = document.getElementById('profile');
    profileEl.innerHTML = '<h1>Welcome ' + userName + '</h1>';
}

// VULNERABLE: XSS via document.write
function renderSettings() {
    const settings = document.location.hash.substring(1);
    document.write('<div>' + settings + '</div>');
}

// VULNERABLE: eval() usage
function runCode(code) {
    eval(code);
}

const config = { apiUrl: 'https://api.example.com' };
"""

VULNERABLE_PROTOTYPE = """
// VULNERABLE: prototype pollution via Object.assign
function mergeConfig(target, source) {
    Object.assign(target, source);
}

// VULNERABLE: __proto__ assignment
function deepMerge(target, source) {
    for (const key in source) {
        if (typeof source[key] === 'object') {
            target[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}

module.exports = { mergeConfig, deepMerge };
"""

VULNERABLE_SQLI = """
// VULNERABLE: SQL injection
function getUser(userId) {
    const query = "SELECT * FROM users WHERE id = " + userId;
    return db.execute(query);
}

function authenticate(username, password) {
    const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
    return db.execute(query);
}
"""

SAFE_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Test App</title>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
</head>
<body>
    <div id="profile"></div>
    <form action="/api/login" method="POST">
        <input name="email" type="email">
        <input name="password" type="password">
    </form>
</body>
</html>
"""


class TestFullPipelineE2E:
    """End-to-end integration tests for the full jsa pipeline (Phase E)."""

    def test_pipeline_with_vulnerable_files(self):
        """Pipeline should process a mix of vulnerable and safe files."""
        files = [
            ("app.js", VULNERABLE_DOM_XSS),
            ("config.js", VULNERABLE_PROTOTYPE),
            ("db.js", VULNERABLE_SQLI),
            ("index.html", SAFE_HTML),
        ]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss", "prototype_pollution", "sqli"],
            js_files=files,
        )

        # Verify all phases ran
        history = state.metadata.get("phase_history", [])
        expected_phases = [
            "INTAKE", "ACQUIRE", "CVE_RESEARCH", "SAST_SCAN",
            "NORMALIZE", "DEDUP_WITHIN_SOURCE", "CORRELATE_EVIDENCE",
            "AGENT_REVIEW", "SAST_VALIDATE", "STRUCTURE", "SLICE",
            "INVESTIGATE", "COLLECT", "MERGE", "VERIFY", "REPORT",
            "REFLECT", "COMPLETED",
        ]
        for phase in expected_phases:
            assert phase in history, f"Phase {phase} missing from {history}"

        # Verify final phase
        assert state.metadata["final_phase"] == "COMPLETED"

    def test_typed_analysis_store_populated(self):
        """STRUCTURE phase should produce a typed analysis store."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        # ModuleCards should be created for each JS/HTML file
        assert len(state.module_cards) >= 1

        # At least one ModuleCard should have dangerous patterns
        cards_with_patterns = [mc for mc in state.module_cards if mc.dangerous_patterns]
        assert len(cards_with_patterns) >= 1

        # Verify dangerous patterns were detected
        patterns = []
        for mc in state.module_cards:
            patterns.extend([p.pattern_id for p in mc.dangerous_patterns])
        # Should find innerHTML, document.write, or eval
        assert any(p in ("innerHTML_assignment", "document_write", "eval_call") for p in patterns)

    def test_flow_cards_generated_for_vulns(self):
        """SLICE phase should generate FlowCards for detected vulnerabilities."""
        files = [
            ("app.js", VULNERABLE_DOM_XSS),
            ("config.js", VULNERABLE_PROTOTYPE),
        ]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss", "prototype_pollution"],
            js_files=files,
        )

        # FlowCards should be generated
        assert len(state.flow_cards) >= 1

        # FlowCards should have proper CWE + sink + lane
        for fc in state.flow_cards:
            # CWE should be set (may be None for some classes, but should not be empty)
            assert fc.cwe_id is None or fc.cwe_id.startswith("CWE-")
            # Sink should be set
            assert fc.sink
            # Lane should be valid
            assert fc.lane in ("code_static", "page_dom", "network_behavior")
            # Source file should be referenced via module_card_ids
            assert fc.module_card_ids

    def test_investigate_produces_per_lane_work_items(self):
        """INVESTIGATE should produce per-lane work items."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss", "cors", "csrf_dom"],
            js_files=files,
        )

        plan = state.metadata["investigate_plan"]

        # Should have at least the code_static work items
        assert plan["lanes"]["code_static"] >= 1

        # Should have work items in metadata
        work_items = state.metadata.get("investigate_work_items", [])
        assert len(work_items) >= 1

        # Each work item should have proper structure
        for wi in work_items:
            assert "work_id" in wi
            assert "lane" in wi
            assert "vuln_class" in wi
            assert "packet_type" in wi
            assert wi["lane"] in ("code_static", "page_dom", "network_behavior")

    def test_waves_computed_correctly(self):
        """INVESTIGATE should compute total_waves based on work items."""
        files = [("app.js", VULNERABLE_DOM_XSS * 10)]  # Larger file = more patterns
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        plan = state.metadata["investigate_plan"]
        # waves = ceil(work_items / 4)
        expected_waves = max(1, (plan["total_agents"] + 3) // 4)
        assert plan["total_waves"] == expected_waves

    def test_page_cards_for_html_files(self):
        """HTML files should produce PageCards."""
        files = [("index.html", SAFE_HTML)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        # Should have a PageCard for the HTML file
        assert len(state.page_cards) >= 1
        # PageCard should have DOM inventory
        for pc in state.page_cards:
            assert pc.url or pc.html_path

    def test_acquire_metadata(self):
        """ACQUIRE phase should set proper metadata."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        acq = state.metadata["acquire_result"]
        assert acq["total_files"] == 1
        assert acq["method"] == "structure_and_slice"

    def test_sast_scan_runs(self):
        """SAST_SCAN phase should record its execution."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        # SAST scan should be in metadata
        sast = state.metadata.get("sast_scan", {})
        assert sast.get("status") is not None

    def test_dedup_phases_run(self):
        """NORMALIZE, DEDUP_WITHIN_SOURCE, CORRELATE_EVIDENCE should run."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        # Each dedup phase should have left traces in metadata
        # - dedup: holds NORMALIZE + DEDUP_WITHIN_SOURCE + CORRELATE_EVIDENCE results
        # - sast_validate: holds SAST_VALIDATE results
        # - agent_review: holds AGENT_REVIEW results
        assert "dedup" in state.metadata
        assert "sast_validate" in state.metadata
        assert "agent_review" in state.metadata

        # Phase history should include the dedup phases
        history = state.metadata.get("phase_history", [])
        for phase in ("NORMALIZE", "DEDUP_WITHIN_SOURCE", "CORRELATE_EVIDENCE"):
            assert phase in history, f"Phase {phase} missing from {history}"

    def test_full_state_to_dict_roundtrip(self):
        """state.to_dict() should produce a JSON-serializable dict."""
        import json
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        d = state.to_dict()
        # Should be JSON-serializable
        s = json.dumps(d, default=str)
        assert len(s) > 0

    def test_reproducible_runs(self):
        """Running the pipeline twice should produce the same end state."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        state1 = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )
        state2 = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        # Compare flow card counts
        assert len(state1.flow_cards) == len(state2.flow_cards)
        # Compare work item counts
        plan1 = state1.metadata["investigate_plan"]
        plan2 = state2.metadata["investigate_plan"]
        assert plan1["total_agents"] == plan2["total_agents"]


class TestPipelineCardProgression:
    """Tests for the card progression through the pipeline."""

    def test_module_cards_have_dangerous_patterns(self):
        """ModuleCards should have AST summary and dangerous patterns."""
        files = [("vuln.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        for mc in state.module_cards:
            # Should have AST summary for JS files
            if mc.filename.endswith(".js"):
                assert mc.ast_summary is not None
            # Module cards should have at least one source
            assert len(mc.sources) >= 1

    def test_flow_cards_have_proper_metadata(self):
        """FlowCards should have CWE, sink, sanitizer, confidence."""
        files = [("vuln.js", VULNERABLE_DOM_XSS)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        valid_confidence = ("candidate", "low", "medium", "high", "confirmed")
        valid_severity = ("info", "low", "medium", "high", "critical")
        for fc in state.flow_cards:
            # CWE should be set or be the generic "xss" class (no specific CWE)
            if fc.cwe_id is not None:
                assert fc.cwe_id.startswith("CWE-")
            # Sink should be set
            assert fc.sink
            # Confidence should be valid
            assert fc.confidence in valid_confidence
            # Severity should be valid
            assert fc.severity in valid_severity

    def test_flow_cards_capped_per_class(self):
        """FlowCards should be capped at 20 per vuln class."""
        # Create a file with many instances of the same vuln pattern
        many_xss = "\n".join(
            f"el.innerHTML = userInput{i};" for i in range(50)
        )
        files = [("many_xss.js", many_xss)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )

        # Count flow cards by class
        from collections import Counter
        class_counts = Counter(fc.vulnerability_class for fc in state.flow_cards)
        for vc, count in class_counts.items():
            assert count <= 20, f"Class {vc} has {count} flow cards (max 20)"


class TestPipelineRobustness:
    """Tests for pipeline robustness with edge cases."""

    def test_empty_files(self):
        """Pipeline should handle empty file list gracefully."""
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=[],
        )
        assert state.metadata["final_phase"] == "COMPLETED"

    def test_files_with_no_patterns(self):
        """Pipeline should handle files with no dangerous patterns."""
        safe_js = "const x = 1; const y = 2; function add(a, b) { return a + b; }"
        files = [("safe.js", safe_js)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )
        assert state.metadata["final_phase"] == "COMPLETED"

    def test_mixed_languages(self):
        """Pipeline should handle a mix of JS and HTML files."""
        files = [
            ("app.js", "el.innerHTML = x;"),
            ("index.html", "<html></html>"),
            ("utils.ts", "const x: number = 1;"),  # TypeScript
        ]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )
        assert state.metadata["final_phase"] == "COMPLETED"
        # Should have module cards for each file
        assert len(state.module_cards) >= 1

    def test_large_file(self):
        """Pipeline should handle a large file efficiently."""
        # 50KB of code
        large_js = "const x = 1;\n" * 10000
        files = [("large.js", large_js)]
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss"],
            js_files=files,
        )
        assert state.metadata["final_phase"] == "COMPLETED"
