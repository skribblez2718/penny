"""
Analyzer unit tests — DOM XSS analyzer.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from analyzers.base import VulnerabilityAnalyzer
from analyzers.dom_xss import DOMXSSAnalyzer


class TestDOMXSSAnalyzer:
    
    def setup_method(self):
        self.analyzer = DOMXSSAnalyzer()
    
    def test_identity(self):
        assert self.analyzer.vuln_class == "dom_xss"
        assert "DOM" in self.analyzer.display_name
        assert "Cross-Site" in self.analyzer.display_name
    
    def test_is_file_level(self):
        assert self.analyzer.is_file_level
        assert not self.analyzer.is_page_level
    
    def test_source_sink_pairs(self):
        pairs = self.analyzer.get_source_sink_pairs()
        assert len(pairs) >= 4  # URL, postMessage, storage, referrer, framework
        for ss in pairs:
            assert ss.name
            assert len(ss.sources) > 0
            assert len(ss.sinks) > 0
            assert ss.severity in ("critical", "high", "medium", "low")
    
    def test_semgrep_rulesets(self):
        rulesets = self.analyzer.get_semgrep_rulesets()
        assert "p/xss" in rulesets
        assert "p/javascript" in rulesets
    
    def test_sink_patterns_for_filtering(self):
        patterns = self.analyzer.get_sink_patterns()
        assert "innerHTML" in str(patterns).lower() or any("innerhtml" in p.lower() for p in patterns)
        assert len(patterns) >= 5
    
    def test_source_patterns_for_filtering(self):
        patterns = self.analyzer.get_source_patterns()
        assert "location.hash" in patterns or "location.search" in patterns
        assert len(patterns) >= 3
    
    def test_payload_templates(self):
        payloads = self.analyzer.get_payload_templates()
        assert len(payloads) >= 4
        for p in payloads:
            assert p.id
            assert p.template
            assert p.target_context in ("html", "attribute", "js_string", "js_code", "url", "template_literal")
    
    def test_verification_procedure(self):
        finding = {
            "finding_id": "12345678-abcd",
            "source": "location.hash",
            "sink": "innerHTML",
            "file": "https://example.com/app.js",
        }
        proc = self.analyzer.get_verification_procedure(finding)
        assert "location.hash" in proc
        assert "innerHTML" in proc
        assert "playwright_navigate" in proc
        assert "playwright_console_messages" in proc
    
    def test_exploitability_assessment(self):
        finding = {"source": "location.hash", "sink": "innerHTML", "evidence": {}}
        result = self.analyzer.assess_exploitability(finding)
        assert result["exploitable"]
        assert result["difficulty"] in ("low", "medium")
    
    def test_exploitability_with_csp(self):
        finding = {
            "source": "location.hash", "sink": "innerHTML",
            "evidence": {"csp_detected": True, "csp_policy": "script-src 'self'"}
        }
        result = self.analyzer.assess_exploitability(finding)
        assert not result["exploitable"]
        assert result.get("bypass_possible")
    
    def test_exploitability_with_trusted_types(self):
        finding = {
            "source": "location.hash", "sink": "element.innerHTML",
            "evidence": {"trusted_types": True}
        }
        result = self.analyzer.assess_exploitability(finding)
        assert not result["exploitable"]
    
    def test_cvss_base(self):
        cvss = self.analyzer.get_cvss_base({})
        assert cvss["AV"] == "N"
        assert cvss["UI"] == "R"
        assert cvss["VC"] == "H"
    
    def test_default_severity(self):
        assert self.analyzer.default_severity == "critical"
    
    def test_analysis_guide_loaded(self):
        guide = self.analyzer.get_analysis_guide()
        assert len(guide) > 100  # Should load annie-dom_xss.md
        assert "DOM" in guide or "XSS" in guide or "dom_xss" in guide.lower()
    
    def test_extends_base_class(self):
        assert isinstance(self.analyzer, VulnerabilityAnalyzer)


class TestBaseClass:
    def test_cannot_instantiate_abstract(self):
        import pytest
        with pytest.raises(TypeError):
            VulnerabilityAnalyzer()


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
