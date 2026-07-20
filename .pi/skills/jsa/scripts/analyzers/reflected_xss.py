"""
Reflected XSS Analyzer.
"""

from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate


class ReflectedXSSAnalyzer(VulnerabilityAnalyzer):
    
    @property
    def vuln_class(self) -> str: return "reflected_xss"
    @property
    def display_name(self) -> str: return "Reflected Cross-Site Scripting"
    @property
    def default_severity(self) -> str: return "critical"
    
    def get_source_sink_pairs(self) -> list[SourceSink]:
        return [
            SourceSink("URL parameter → HTML body", ["location.search", "URLSearchParams", "req.query", "req.params"], ["innerHTML", "document.write", "res.send", "res.render", "$.html()"], "critical", "CWE-79"),
            SourceSink("URL parameter → HTML attribute", ["location.search", "URLSearchParams"], ["setAttribute", "element.attr", "href", "src"], "high", "CWE-79"),
            SourceSink("URL parameter → JavaScript context", ["location.search", "URLSearchParams"], ["eval()", "new Function()", "setTimeout(string)"], "critical", "CWE-79"),
            SourceSink("HTTP header → DOM", ["document.referrer", "window.name"], ["innerHTML", "document.write", "eval()"], "medium", "CWE-79"),
        ]
    
    def get_semgrep_rulesets(self) -> list[str]:
        return ["p/xss", "p/javascript", "p/typescript", "p/owasp-top-ten", "p/security-audit"]
    
    def get_custom_scanners(self) -> list[str]:
        return ["reflected_xss_scanner", "reflected_parameter_scanner"]
    
    
    def get_payload_templates(self) -> list[PayloadTemplate]:
        return [
            PayloadTemplate("rxss-html", "HTML body injection", "<img src=x onerror=alert(1)>", target_context="html"),
            PayloadTemplate("rxss-attr", "Attribute break-out", '"><img src=x onerror=alert(1)>', target_context="attribute"),
            PayloadTemplate("rxss-js", "JS string break-out", "'; alert(1); //", target_context="js_string"),
            PayloadTemplate("rxss-href", "href javascript:", "javascript:alert(1)", target_context="url"),
        ]
    
    def get_verification_procedure(self, finding: dict) -> str:
        return f"""## Reflected XSS Verification: {finding.get('source')} → {finding.get('sink')}
playwright_navigate("{finding.get('file')}?{finding.get('source','q')}=<img src=x onerror=console.log('RXSS')>")
playwright_console_messages(level="log")
playwright_screenshot(path="evidence/rxss-poc.png")
"""
    
    def assess_exploitability(self, finding: dict) -> dict:
        return {"exploitable": True, "difficulty": "low", "preconditions": ["User must click attacker-crafted URL"]}
    
    def get_cvss_base(self, finding: dict) -> dict:
        return {"AV": "N", "AC": "L", "AT": "N", "PR": "N", "UI": "R", "VC": "H", "VI": "H", "VA": "N", "SC": "H", "SI": "H", "SA": "N"}
