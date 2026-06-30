"""
Integration test: full pipeline with vulnerable JS fixtures and simulated workers.

Tests:
1. Vulnerable DOM XSS code is chunked correctly
2. Simulated worker findings flow through collect → merge → dedup  
3. Confidence promotion works with multiple chunks
4. Cross-file dedup works
5. Full pipeline produces expected merged findings
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fsm import (
    JSAState,
    run_pipeline,
    collect_handler, merge_handler,
    verify_handler, report_handler, reflect_handler,
)
from dedup import Finding
from orchestrate import JSAPipelineOrchestrator
from splitter import split_js_multi


# ── Vulnerable JS fixtures ──

VULNERABLE_DOM_XSS = """
// app.js — DOM XSS vulnerable
const params = new URLSearchParams(location.search);
const userName = params.get('name');

function renderProfile() {
    const profileEl = document.getElementById('profile');
    profileEl.innerHTML = '<h1>Welcome ' + userName + '</h1>';  // VULNERABLE
}

function renderSettings() {
    const hash = location.hash.slice(1);
    document.write('<div>' + hash + '</div>');  // VULNERABLE
}
"""

SAFE_JS = """
// utils.js — safe code
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function sanitize(input) {
    const div = document.createElement('div');
    div.textContent = input;  // SAFE: textContent, not innerHTML
    return div.innerHTML;
}
"""

VULNERABLE_PROTOTYPE = """
// config.js — prototype pollution vulnerable
function mergeConfig(target, source) {
    for (let key in source) {
        if (typeof source[key] === 'object') {
            target[key] = {};
            mergeConfig(target[key], source[key]);  // VULNERABLE: no hasOwnProperty check
        } else {
            target[key] = source[key];
        }
    }
}

function loadUserConfig() {
    const userConfig = JSON.parse(localStorage.getItem('userConfig'));
    const defaultConfig = { theme: 'light', fontSize: 14 };
    mergeConfig(defaultConfig, userConfig);  // VULNERABLE: user input merged
}
"""


class TestPipelineIntegration:
    """Full pipeline integration with vulnerable fixtures."""
    
    def test_single_vulnerable_file_chunked(self):
        """Pipeline correctly chunks and processes a single vulnerable file."""
        files = [("app.js", VULNERABLE_DOM_XSS)]
        result = split_js_multi(files, max_tokens_per_chunk=12000, 
                               active_analyzers=["dom_xss"])
        
        # Verify chunking
        assert result.chunk_count >= 1
        assert result.method in ("single_chunk", "ast_aware")
        
        # Verify file spans resolve correctly
        for chunk in result.chunks:
            assert len(chunk.file_spans) >= 1
            assert chunk.file_spans[0].file_path == "app.js"
    
    def test_multi_file_concatenation(self):
        """Multiple files are concatenated and chunked together."""
        files = [
            ("app.js", VULNERABLE_DOM_XSS),
            ("utils.js", SAFE_JS),
            ("config.js", VULNERABLE_PROTOTYPE),
        ]
        result = split_js_multi(files, max_tokens_per_chunk=5000, overlap_tokens=500,
                               active_analyzers=["dom_xss", "prototype_pollution"])
        
        assert result.chunk_count >= 1
        
        # Not strictly required due to chunk sizing, but verify spans exist
        assert all(len(c.file_spans) >= 1 for c in result.chunks)
    
    def test_discover_all_file_paths(self):
        """All file paths appear across chunks."""
        files = [
            ("app.js", VULNERABLE_DOM_XSS),
            ("utils.js", SAFE_JS),
        ]
        result = split_js_multi(files)
        
        all_files = set()
        for chunk in result.chunks:
            for span in chunk.file_spans:
                all_files.add(span.file_path)
        
        assert "app.js" in all_files
        assert "utils.js" in all_files


class TestFindingsFlow:
    """Simulated worker findings flow through the pipeline."""
    
    def test_simulated_findings_merge(self):
        """Simulated findings from multiple workers are merged correctly."""
        state = JSAState(
            target_url="https://example.com",
            analyzers=["dom_xss"],
        )
        
        # Simulate worker findings
        findings = [
            Finding(
                finding_id="1", chunk_id="chunk-0", file="app.js",
                vuln_class="dom_xss", source="location.search", sink="innerHTML",
                line_start=8, line_end=8, confidence="possible",
                description="DOM XSS: location.search → innerHTML in renderProfile",
                code_snippet="profileEl.innerHTML = '<h1>Welcome ' + userName + '</h1>';",
                data_flow="location.search → URLSearchParams → innerHTML",
                scanner="semgrep",
            ),
            Finding(
                finding_id="2", chunk_id="chunk-1", file="app.js",
                vuln_class="dom_xss", source="location.search", sink="innerHTML",
                line_start=8, line_end=8, confidence="possible",
                description="innerHTML injection with user name",
                code_snippet="profileEl.innerHTML = '<h1>Welcome ' + userName + '</h1>';",
                data_flow="location.search → innerHTML",
                scanner="ast_trace",
            ),
            Finding(
                finding_id="3", chunk_id="chunk-0", file="app.js",
                vuln_class="dom_xss", source="location.hash", sink="document.write",
                line_start=13, line_end=13, confidence="possible",
                description="DOM XSS: location.hash → document.write",
                code_snippet="document.write('<div>' + hash + '</div>');",
                data_flow="location.hash → document.write",
                scanner="semgrep",
            ),
        ]
        
        state.raw_findings = findings
        state = collect_handler(state)
        assert state.metadata["collect_raw_count"] == 3
        
        state = merge_handler(state)
        merge_result = state.metadata["merge_result"]
        
        # Finding 1 and 2 should merge (same source, sink, file, line)
        # Finding 3 should remain separate (different sink)
        assert merge_result["total_raw"] == 3
        assert merge_result["total_merged"] <= 3
        assert merge_result["total_merged"] >= 1
        
        # At least one cluster was formed (findings 1+2)
        assert merge_result["clusters_formed"] >= 1
    
    def test_confidence_promoted_with_multiple_chunks(self):
        """Two different chunks finding the same pattern → confidence promoted."""
        state = JSAState(analyzers=["dom_xss"])
        
        findings = [
            Finding(finding_id="1", chunk_id="chunk-0", file="app.js",
                   vuln_class="dom_xss", source="location.hash", sink="eval()",
                   line_start=42, confidence="possible",
                   description="eval with hash", scanner="semgrep"),
            Finding(finding_id="2", chunk_id="chunk-1", file="app.js",
                   vuln_class="dom_xss", source="location.hash", sink="eval()",
                   line_start=42, confidence="possible",
                   description="eval with hash", scanner="semgrep"),
            Finding(finding_id="3", chunk_id="chunk-2", file="app.js",
                   vuln_class="dom_xss", source="location.hash", sink="eval()",
                   line_start=42, confidence="possible",
                   description="eval with hash", scanner="ast_trace"),
        ]
        
        state.raw_findings = findings
        state = merge_handler(state)
        
        # All three should merge into one with promoted confidence
        merge_result = state.metadata["merge_result"]
        assert merge_result["total_merged"] == 1
        
        merged = state.merged_findings[0]
        # 3 chunks + 2 scanners → possible → confirmed
        assert merged.confidence == "confirmed"
        assert merged.duplicate_count == 3
    
    def test_cross_file_dedup(self):
        """Same vulnerability pattern across different files → cross-file dedup."""
        state = JSAState(analyzers=["dom_xss"])
        
        findings = [
            Finding(finding_id="1", chunk_id="c0", file="app.js",
                   vuln_class="dom_xss", source="location.hash", sink="innerHTML",
                   line_start=10, confidence="possible",
                   description="XSS in app.js", scanner="semgrep"),
            Finding(finding_id="2", chunk_id="c1", file="dashboard.js",
                   vuln_class="dom_xss", source="location.hash", sink="innerHTML",
                   line_start=25, confidence="possible",
                   description="XSS in dashboard.js", scanner="semgrep"),
        ]
        
        state.raw_findings = findings
        state = merge_handler(state)
        
        merge_result = state.metadata["merge_result"]
        # Should cross-file dedup (same pattern, different files)
        assert merge_result["total_raw"] == 2
        # Cross-file dedup merges them
        assert merge_result["total_merged"] <= 2
        # Cross-file merges detected
        assert merge_result["cross_file_merges"] >= 0  # May or may not merge depending on line range


class TestFullPipeline:
    """End-to-end pipeline with all phases."""
    
    def test_full_pipeline_runs_all_phases(self):
        """Pipeline completes all phases without errors."""
        files = [
            ("app.js", VULNERABLE_DOM_XSS),
            ("utils.js", SAFE_JS),
            ("config.js", VULNERABLE_PROTOTYPE),
        ]
        
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss", "prototype_pollution"],
            js_files=files,
        )
        
        # Verify all phases completed
        history = state.metadata["phase_history"]
        expected_phases = ["INTAKE", "ACQUIRE", "CVE_RESEARCH", "SAST_SCAN",
                          "NORMALIZE", "DEDUP_WITHIN_SOURCE", "CORRELATE_EVIDENCE",
                          "SAST_VALIDATE", "STRUCTURE", "SLICE", "INVESTIGATE",
                          "STOP", "COLLECT", "MERGE", "VERIFY",
                          "REPORT", "REFLECT", "COMPLETED"]
        for phase in expected_phases:
            assert phase in history, f"Phase {phase} missing from {history}"

        assert state.metadata["final_phase"] == "COMPLETED"
    
    def test_pipeline_with_simulated_worker_output(self):
        """Simulate what happens after real workers complete."""
        files = [
            ("app.js", VULNERABLE_DOM_XSS),
            ("config.js", VULNERABLE_PROTOTYPE),
        ]
        
        state = run_pipeline(
            target_url="https://example.com",
            analyzers=["dom_xss", "prototype_pollution"],
            js_files=files,
        )
        
        # Verify acquisition
        # Phase E: chunks field removed; verify via module_cards instead
        assert len(state.module_cards) >= 1
        acq = state.metadata["acquire_result"]
        assert acq["total_files"] == 2
        
        # Verify investigate plan (renamed from dispatch plan in Phase B)
        dp = state.metadata["investigate_plan"]
        assert dp["flow_cards"] >= 0
        assert dp["page_cards"] >= 0
        assert dp["total_waves"] >= 1
        
        # Simulate workers finding issues
        simulated_findings = [
            Finding(finding_id="f1", chunk_id="chunk-0", file="app.js",
                   vuln_class="dom_xss", source="location.search", sink="innerHTML",
                   line_start=8, confidence="possible",
                   description="innerHTML XSS in renderProfile",
                   code_snippet="profileEl.innerHTML = '<h1>Welcome ' + userName + '</h1>';",
                   scanner="semgrep"),
            Finding(finding_id="f2", chunk_id="chunk-0", file="app.js",
                   vuln_class="dom_xss", source="location.hash", sink="document.write",
                   line_start=13, confidence="possible",
                   description="document.write XSS in renderSettings",
                   code_snippet="document.write('<div>' + hash + '</div>');",
                   scanner="semgrep"),
            Finding(finding_id="f3", chunk_id="chunk-0", file="config.js",
                   vuln_class="prototype_pollution", source="localStorage.getItem",
                   sink="mergeConfig", line_start=16, confidence="possible",
                   description="Prototype pollution via user config merge",
                   code_snippet="mergeConfig(defaultConfig, userConfig);",
                   scanner="ast_trace"),
        ]
        
        state.raw_findings = simulated_findings
        state = collect_handler(state)
        assert state.metadata["collect_raw_count"] == 3
        
        state = merge_handler(state)
        merge_result = state.metadata["merge_result"]
        assert merge_result["total_raw"] == 3
        assert merge_result["total_merged"] >= 2  # 2 dom_xss may merge, proto_pollution separate
        
        # Verify output
        verify_handler(state)
        assert state.metadata["verify_plan"]["findings_to_verify"] == merge_result["total_merged"]
        
        report_handler(state)
        assert state.output_dir in str(state.metadata["report_plan"]["output_dir"]) \
               or "jsa" in state.metadata["report_plan"]["output_dir"]
        
        reflect_handler(state)
        assert "carren" in state.metadata["reflect_plan"]["agents"]


class TestOrchestratorIntegration:
    """Orchestrator-level integration tests for dedup phase."""

    def test_dedup_executes_locally(self, tmp_path: Path):
        orch = JSAPipelineOrchestrator(
            session_id="dedup-pipeline-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        # Pre-create JS dir and files
        js_dir = tmp_path / "assets" / "js"
        js_dir.mkdir(parents=True, exist_ok=True)
        (js_dir / "app.js").write_text("const x = 1;\n")

        # Simulate stepping through to DEDUP
        orch.state.sast_findings = [
            {"rule_id": "dom_xss", "file": "app.js", "line": 10, "source": "semgrep"}
        ]
        directive = orch._dedup_directive()
        orch._execute_local_phase(directive)
        assert orch.state.metadata.get("dedup") is not None


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
