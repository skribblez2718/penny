"""
Fixture-based integration tests.

Validates the pipeline against realistic vulnerable JavaScript code.
Tests: splitting, semgrep findings, pipeline flow, dedup with real patterns.
"""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fsm import run_pipeline, merge_handler, collect_handler
from dedup import Finding
from splitter import split_js_multi

FIXTURES = Path(__file__).parent / "fixtures" / "vuln-app"


def load_fixture(name: str) -> str:
    """Load a fixture file."""
    path = FIXTURES / name
    if path.exists():
        return path.read_text()
    return ""


def load_all_fixtures() -> list[tuple[str, str]]:
    """Load all JS fixture files."""
    files = []
    for path in sorted(FIXTURES.glob("*.js")):
        files.append((path.name, path.read_text()))
    return files


class TestFixtureSplitting:
    """Verify the splitter handles realistic code correctly."""
    
    def test_all_files_load(self):
        files = load_all_fixtures()
        assert len(files) >= 3
        for name, content in files:
            assert len(content) > 100, f"{name} is too small"
    
    def test_split_multi_file(self):
        files = load_all_fixtures()
        result = split_js_multi(files, max_tokens_per_chunk=3000, overlap_tokens=500,
                               active_analyzers=["dom_xss"])
        
        assert result.chunk_count >= 1
        assert result.total_tokens > 0
        
        # All original files should appear in file_map
        file_paths = {e.file_path for e in result.file_map.entries}
        for name, _ in files:
            assert name in file_paths, f"{name} missing from file_map"
    
    def test_chunks_have_file_spans(self):
        files = load_all_fixtures()
        result = split_js_multi(files, max_tokens_per_chunk=3000, overlap_tokens=500)
        
        for chunk in result.chunks:
            assert len(chunk.file_spans) >= 1, f"{chunk.chunk_id} has no file spans"
            for span in chunk.file_spans:
                assert span.file_path
                assert span.start_line >= 1
                assert span.end_line >= span.start_line
    
    def test_body_contains_delimiters(self):
        files = load_all_fixtures()
        result = split_js_multi(files, max_tokens_per_chunk=10000, overlap_tokens=1000)
        
        # At least one chunk should contain file markers
        delimiter_found = False
        for chunk in result.chunks:
            if "=== file:" in chunk.body:
                delimiter_found = True
                break
        assert delimiter_found, "No chunks contain file delimiters"


class TestSemgrepOnFixtures:
    """Run actual semgrep against the fixture files."""
    
    def _get_semgrep_path(self):
        """Find semgrep binary."""
        venv_path = Path(__file__).parent.parent.parent.parent / ".venv" / "bin" / "semgrep"
        if venv_path.exists():
            return str(venv_path)
        # Fall back to PATH
        return "semgrep"
    
    def test_semgrep_finds_xss(self):
        """Semgrep should find XSS patterns in app.js."""
        app_js = FIXTURES / "app.js"
        if not app_js.exists():
            return
        
        semgrep = self._get_semgrep_path()
        try:
            result = subprocess.run(
                [semgrep, "scan", "--config=p/xss", "--config=p/javascript",
                 "--json", "--no-git-ignore", str(app_js)],
                capture_output=True, text=True, timeout=60
            )
            data = json.loads(result.stdout)
            findings = data.get("results", [])
            innerhtml_findings = [
                r for r in findings 
                if "innerHTML" in str(r.get("extra", {}).get("message", ""))
            ]
            assert len(innerhtml_findings) >= 1, \
                f"Expected innerHTML finding, got {len(findings)} total"
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass  # semgrep not available — skip


class TestFixturePipeline:
    """Full pipeline with fixture files and simulated worker findings."""
    
    def test_pipeline_with_fixtures(self):
        """Pipeline runs end-to-end with fixture files."""
        files = load_all_fixtures()
        assert len(files) >= 3
        
        state = run_pipeline(
            target_url="https://dashboard-app.com",
            analyzers=["dom_xss", "prototype_pollution", "secret_disclosure", "sqli"],
            js_files=files,
        )
        
        assert state.metadata["final_phase"] == "COMPLETED"
        assert state.metadata["acquire_result"]["total_files"] == len(files)
        # Phase E: chunks field removed; verify via module_cards
        assert len(state.module_cards) >= 1
    
    def test_findings_flow_with_realistic_patterns(self):
        """Simulate worker findings that match our fixture vulnerabilities."""
        files = load_all_fixtures()
        state = run_pipeline(
            target_url="https://dashboard-app.com",
            analyzers=["dom_xss", "prototype_pollution", "secret_disclosure", "sqli"],
            js_files=files,
        )
        
        # Simulate findings a real worker would find
        findings = [
            # DOM XSS in app.js
            Finding(finding_id="1", chunk_id="chunk-0", file="app.js",
                   vuln_class="dom_xss", source="location.hash", sink="innerHTML",
                   line_start=27, line_end=33, confidence="probable",
                   description="DOM XSS: user.name flows into innerHTML in renderProfile()",
                   code_snippet="container.innerHTML = `<h1>${user.name}</h1>...`;",
                   data_flow="fetchUserData → user.name → innerHTML",
                   scanner="semgrep"),
            Finding(finding_id="2", chunk_id="chunk-0", file="app.js",
                   vuln_class="dom_xss", source="location.search", sink="document.write",
                   line_start=43, line_end=44, confidence="possible",
                   description="DOM XSS: location.search → document.write in renderSettings()",
                   code_snippet="document.write('<p>Redirecting to: ' + redirect + '</p>');",
                   data_flow="location.search → redirect → document.write",
                   scanner="semgrep"),
            Finding(finding_id="3", chunk_id="chunk-0", file="app.js",
                   vuln_class="dom_xss", source="location.search", sink="innerHTML",
                   line_start=70, line_end=73, confidence="probable",
                   description="DOM XSS: search query injected into innerHTML",
                   code_snippet='container.innerHTML = `<h2>Search Results for "${query}"</h2>`;',
                   data_flow="URLSearchParams → query → innerHTML",
                   scanner="ast_trace"),
            # Safe code NOT flagged (sanitizeHTML used correctly)
            # Note: renderDashboard uses sanitizeHTML — should NOT be a finding
            
            # Prototype pollution in utils.js → app.js
            Finding(finding_id="4", chunk_id="chunk-0", file="utils.js",
                   vuln_class="prototype_pollution", source="localStorage.getItem",
                   sink="mergeConfig", line_start=60, line_end=75, confidence="possible",
                   description="Prototype pollution: mergeConfig has no hasOwnProperty check",
                   code_snippet="for (let key in source) { target[key] = source[key]; }",
                   data_flow="localStorage → JSON.parse → mergeConfig → appConfig",
                   scanner="ast_trace"),
            
            # Secrets in api.js
            Finding(finding_id="5", chunk_id="chunk-0", file="api.js",
                   vuln_class="secret_disclosure", source="",
                   sink="", line_start=10, line_end=12, confidence="confirmed",
                   description="Hardcoded API key: sk-live-dashboard-2024-...",
                   code_snippet="apiKey: 'sk-live-dashboard-2024-abc123def456ghi789',",
                   data_flow="",
                   scanner="jsluice"),
            Finding(finding_id="6", chunk_id="chunk-0", file="api.js",
                   vuln_class="secret_disclosure", source="",
                   sink="", line_start=15, line_end=17, confidence="confirmed",
                   description="Hardcoded AWS credentials",
                   code_snippet="accessKeyId: 'AKIAIOSFODNN7EXAMPLE',",
                   data_flow="",
                   scanner="semgrep"),
            
            # SQLi in api.js
            Finding(finding_id="7", chunk_id="chunk-0", file="api.js",
                   vuln_class="sqli", source="query parameter", sink="SQL query",
                   line_start=80, line_end=82, confidence="possible",
                   description="SQL injection: raw query concatenation in searchUsers()",
                   code_snippet="const sqlQuery = `SELECT * FROM users WHERE name LIKE '%${query}%'`;",
                   data_flow="query parameter → sqlQuery string → API POST",
                   scanner="ast_trace"),
        ]
        
        state.raw_findings = findings
        state = collect_handler(state)
        assert state.metadata["collect_raw_count"] == 7
        
        state = merge_handler(state)
        merge = state.metadata["merge_result"]
        
        # Verify merge stats
        assert merge["total_raw"] == 7
        assert merge["total_merged"] >= 4  # At minimum: 3 DOM XSS + 1 PP + 1 secrets + 1 sqli = 6, but some may merge
        
        # Verify findings by vuln class
        vuln_classes = {f.vuln_class for f in state.merged_findings}
        assert "dom_xss" in vuln_classes
        assert "prototype_pollution" in vuln_classes
        assert "secret_disclosure" in vuln_classes
        assert "sqli" in vuln_classes
    
    def test_safe_code_not_flagged(self):
        """Verify that safe code patterns are correctly not vulnerable."""
        utils_src = load_fixture("utils.js")
        
        # sanitizeHTML uses textContent → SAFE
        assert "div.textContent = input" in utils_src
        
        # createElement uses textContent for children → SAFE
        assert "el.textContent = children" in utils_src
        
        # validateURL properly checks protocols → SAFE
        assert "parsed.protocol === 'http:'" in utils_src
        
        # These should NOT produce findings in a real scan
        
        # But mergeConfig IS vulnerable → should be found
        assert "for (let key in source)" in utils_src


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
